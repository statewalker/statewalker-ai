import type { ModelMessage } from "ai";
import { NodeType } from "../state/node-types.js";
import type { SessionState } from "../state/session-state.js";
import type { ToolCall } from "../state/tool-call.js";
import type { TreeNode } from "../state/tree-node.js";
import type { Turn } from "../state/turn.js";
import type { TurnGroup } from "../state/turn-group.js";
import { containsPinned, type PinPolicy } from "./pin-policy.js";
import type { SelectionStrategy } from "./select-messages.js";
import type { TokenEstimator } from "./token-estimator.js";
import { elideToolResponse, type ToolElisionPolicy } from "./tool-elision.js";

export interface SelectHierarchicalOptions {
  budgetTokens: number;
  keepRecentTurns: number;
  pinPolicy: PinPolicy;
  elisionPolicy: ToolElisionPolicy;
  estimator: TokenEstimator;
}

/**
 * Build a `ModelMessage[]` projection from a session tree, honouring group
 * summaries, pinning, tool-result elision, and a token budget.
 *
 * The selector never mutates the tree. It walks the session's direct
 * children in document order, emitting:
 *
 *  - raw `Turn`   → verbatim `toModelMessages()` with elision applied to
 *                   any `tool_response` nodes (projection only).
 *  - `TurnGroup` → a single synthetic user message `[group:{stamp}] {body}`
 *                   OR — when a pinned descendant lives inside it — a
 *                   recursive expansion of its children.
 *
 * After the initial walk, if the estimated token count exceeds
 * `budgetTokens`, the selector walks back from the deepest expanded group
 * outward, collapsing expansions to their summary messages until the
 * estimate fits. Pin-forced expansions are never collapsed.
 */
export function selectHierarchical(options: SelectHierarchicalOptions): SelectionStrategy {
  return async (session: SessionState) => {
    options.pinPolicy.prepare?.(session);

    // Build expansion plan: one entry per direct child of the session plus
    // the recursive expansion decisions inside.
    const tailCount = Math.max(0, options.keepRecentTurns);
    const directChildren = session.children;
    const tailStart = Math.max(0, directChildren.length - tailCount);

    const plan: PlanNode[] = [];
    for (let i = 0; i < directChildren.length; i++) {
      const child = directChildren[i];
      if (!child) continue;
      const inTail = i >= tailStart;
      plan.push(buildPlanNode(child, options.pinPolicy, inTail));
    }

    // Initial projection.
    let messages = materialise(plan, options);

    // Budget-driven demotion — collapse deepest expansions first.
    if (options.estimator.estimate(messages) > options.budgetTokens) {
      demoteUntilFits(plan, options);
      messages = materialise(plan, options);
    }

    return messages;
  };
}

// ── Plan construction ───────────────────────────────────────

type PlanNode =
  | {
      kind: "turn";
      turn: Turn;
      pinnedSelf: boolean;
    }
  | {
      kind: "group-summary";
      group: TurnGroup;
    }
  | {
      kind: "group-expanded";
      group: TurnGroup;
      children: PlanNode[];
      pinned: boolean; // expansion forced by pinned descendant — do not collapse
    };

function buildPlanNode(node: TreeNode, pin: PinPolicy, _inTail: boolean): PlanNode {
  if (node.type === NodeType.turnGroup) {
    const group = node as TurnGroup;
    const hasPinned = containsPinned(group, pin);
    if (hasPinned) {
      const children: PlanNode[] = [];
      for (const c of group.children) {
        children.push(buildPlanNode(c, pin, false));
      }
      return { kind: "group-expanded", group, children, pinned: true };
    }
    return { kind: "group-summary", group };
  }
  // Raw Turn (or anything else) always passes through verbatim.
  return {
    kind: "turn",
    turn: node as Turn,
    pinnedSelf: pin.shouldPin(node),
  };
}

// ── Materialisation ─────────────────────────────────────────

function materialise(plan: PlanNode[], options: SelectHierarchicalOptions): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const p of plan) {
    materialiseInto(p, options, out);
  }
  return out;
}

function materialiseInto(
  node: PlanNode,
  options: SelectHierarchicalOptions,
  out: ModelMessage[],
): void {
  if (node.kind === "turn") {
    const msgs = renderTurn(node.turn, options.elisionPolicy);
    out.push(...msgs);
    return;
  }
  if (node.kind === "group-summary") {
    out.push(renderGroupSummary(node.group));
    return;
  }
  for (const c of node.children) {
    materialiseInto(c, options, out);
  }
}

// Render a single raw Turn with tool-result elision applied.
function renderTurn(turn: Turn, elision: ToolElisionPolicy): ModelMessage[] {
  const base = turn.toModelMessages();
  return base.map((msg) => applyElisionToMessage(msg, turn, elision));
}

function applyElisionToMessage(
  msg: ModelMessage,
  turn: Turn,
  elision: ToolElisionPolicy,
): ModelMessage {
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) return msg;
  const role = (msg as { role?: unknown }).role;
  if (role !== "tool") return msg;

  // Each item in a tool-role content array is a tool-result part; look up
  // the originating ToolCall by `toolCallId` so we know the policy target.
  const byCallId = new Map<string, ToolCall>();
  for (const child of turn.children) {
    if (child.type === NodeType.toolCall) {
      const tc = child as ToolCall;
      byCallId.set(tc.callId, tc);
    }
  }

  const patchedParts = content.map((part) => {
    if (!part || typeof part !== "object") return part;
    const p = part as Record<string, unknown>;
    if (p.type !== "tool-result") return part;
    const callId = p.toolCallId as string | undefined;
    const tc = callId ? byCallId.get(callId) : undefined;
    if (!tc) return part;
    const output = p.output as { type?: string; value?: unknown } | undefined;
    if (!output || output.type !== "json") return part;
    const raw = typeof output.value === "string" ? output.value : "";
    if (!raw) return part;
    const elided = elideToolResponse(raw, tc.toolName, tc.args, elision);
    if (elided === raw) return part;
    return {
      ...p,
      output: { type: "json", value: elided },
    };
  });

  return { ...(msg as object), content: patchedParts } as ModelMessage;
}

// Render a TurnGroup's summary as a synthetic user message.
function renderGroupSummary(group: TurnGroup): ModelMessage {
  const stamp = group.stamp ?? "unstamped";
  const body = group.summaryText ?? "(no summary)";
  const sections = group.sections;
  let text = `[group:${stamp}] ${body}`;
  if (sections && sections.length > 0) {
    const rendered = sections
      .map((s) => `## ${s.title}\n${s.body}\nrefs: ${s.refs.join(", ")}`)
      .join("\n\n");
    text += `\n\n${rendered}`;
  }
  return { role: "user", content: text };
}

// ── Demotion ────────────────────────────────────────────────

function demoteUntilFits(plan: PlanNode[], options: SelectHierarchicalOptions): void {
  // Collect collapsible expansions ordered by descending depth so the
  // deepest ones collapse first.
  const demotable = collectDemotable(plan);
  demotable.sort((a, b) => b.depth - a.depth);
  for (const entry of demotable) {
    // Replace the plan entry in place.
    replacePlanEntry(entry.parentList, entry.index, {
      kind: "group-summary",
      group: entry.node.group,
    });
    const materialised = materialise(plan, options);
    if (options.estimator.estimate(materialised) <= options.budgetTokens) {
      return;
    }
  }
}

interface DemotableEntry {
  parentList: PlanNode[];
  index: number;
  node: Extract<PlanNode, { kind: "group-expanded" }>;
  depth: number;
}

function collectDemotable(plan: PlanNode[]): DemotableEntry[] {
  const out: DemotableEntry[] = [];
  walkDemotable(plan, 0, out);
  return out;
}

function walkDemotable(list: PlanNode[], depth: number, out: DemotableEntry[]): void {
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!p || p.kind !== "group-expanded") continue;
    if (!p.pinned) out.push({ parentList: list, index: i, node: p, depth });
    walkDemotable(p.children, depth + 1, out);
  }
}

function replacePlanEntry(list: PlanNode[], index: number, replacement: PlanNode): void {
  list[index] = replacement;
}
