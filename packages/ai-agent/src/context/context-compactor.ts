import type { LogMessage } from "../state/log-message.js";
import type { Message } from "../state/message.js";
import { NodeType } from "../state/node-types.js";
import type { Session } from "../state/session.js";
import type { ToolCall } from "../state/tool-call.js";
import type { TreeNode } from "../state/tree-node.js";
import type { Turn } from "../state/turn.js";
import type { TurnGroup } from "../state/turn-group.js";
import { LEGACY_STAMP, newStamp } from "./compaction-stamp.js";
import type { HierarchicalSummarizer } from "./hierarchical-summarizer.js";
import { containsPinned, type PinPolicy } from "./pin-policy.js";
import type { TokenEstimator } from "./token-estimator.js";
import { elideToolResponse, type ToolElisionPolicy } from "./tool-elision.js";

const DEFAULT_MAX_PASSES = 8;
const DEFAULT_GROUP_SIZE = 6;
const DEFAULT_DEPTH_PROMOTE_THRESHOLD = 4;
const DEFAULT_KEEP_RECENT_TURNS = 4;

export interface CompactOptions {
  budgetTokens: number;
  summarizer: HierarchicalSummarizer;
  estimator: TokenEstimator;
  pinPolicy: PinPolicy;
  elisionPolicy: ToolElisionPolicy;
  keepRecentTurns?: number;
  groupSize?: number;
  depthPromoteThreshold?: number;
  maxPassesPerCompact?: number;
  /** Optional sink that receives `context-thrash` LogMessage events. */
  eventSink?: (event: LogMessage) => void;
}

export interface CompactResult {
  passes: number;
  newGroups: string[];
  stamp: string | null;
  thrashed: boolean;
  elided: boolean;
}

/**
 * Layered hierarchical compaction. Run before each model call when a
 * session may have grown beyond the configured budget. The compactor
 * mutates the session tree by adopting old turns under `TurnGroup`
 * wrappers; it never drops data.
 */
export class ContextCompactor {
  async compact(session: Session, options: CompactOptions): Promise<CompactResult> {
    const keepRecent = options.keepRecentTurns ?? DEFAULT_KEEP_RECENT_TURNS;
    const groupSize = options.groupSize ?? DEFAULT_GROUP_SIZE;
    const promoteThreshold = options.depthPromoteThreshold ?? DEFAULT_DEPTH_PROMOTE_THRESHOLD;
    const maxPasses = options.maxPassesPerCompact ?? DEFAULT_MAX_PASSES;

    options.pinPolicy.prepare?.(session);

    // 1. Legacy migration (once per compact call, no LLM).
    const migratedAnyLegacy = migrateLegacySummaries(session, keepRecent);

    // 2. Short-circuit: already under budget without any work (not even elision).
    const rawEstimate = estimateSession(session, options.estimator, /* elision */ undefined);
    if (rawEstimate <= options.budgetTokens) {
      return {
        passes: 0,
        newGroups: [],
        stamp: migratedAnyLegacy ? LEGACY_STAMP : null,
        thrashed: false,
        elided: false,
      };
    }

    const stamp = newStamp();
    const newGroups: string[] = [];
    let passes = 0;
    let elided = false;
    let thrashed = false;

    while (passes < maxPasses) {
      passes += 1;

      // Step 1 — elision projection. Elision never mutates the tree; we
      // estimate *with* elision applied and return if that alone is enough.
      const elidedEst = estimateSession(session, options.estimator, options.elisionPolicy);
      if (elidedEst <= options.budgetTokens) {
        elided = true;
        break;
      }

      // Step 2 — form a new depth-1 group if possible.
      const depth1Group = await formDepth1Group(session, groupSize, keepRecent, options, stamp);
      if (depth1Group) {
        newGroups.push(depth1Group.id);
        continue;
      }

      // Step 3 — depth promotion when a run of same-depth groups exists.
      const promoted = await promoteGroups(session, promoteThreshold, keepRecent, options, stamp);
      if (promoted) {
        newGroups.push(promoted.id);
        continue;
      }

      // Step 4 — no action possible and still over budget: thrash guard.
      thrashed = true;
      break;
    }

    if (thrashed || passes >= maxPasses) {
      thrashed = true;
      const finalEst = estimateSession(session, options.estimator, options.elisionPolicy);
      options.eventSink?.({
        type: "context-thrash",
        turnId: "",
        stamp,
        budget: options.budgetTokens,
        estimated: finalEst,
      });
    }

    return { passes, newGroups, stamp, thrashed, elided };
  }
}

// ── Legacy migration ────────────────────────────────────────

/**
 * If the session has any direct `Turn` children carrying legacy
 * `props.summary` strings, wrap the contiguous prefix of such turns
 * (outside the recent tail) into a single depth-1 group whose `content`
 * is the concatenation of those legacy summaries. Marks the group with
 * `stamp = LEGACY_STAMP`. No LLM is called.
 */
function migrateLegacySummaries(session: Session, keepRecentTurns: number): boolean {
  const directChildren = session.children;
  const cutoff = Math.max(0, directChildren.length - keepRecentTurns);
  let fromIdx = -1;
  let toIdx = -1;
  const legacyTexts: string[] = [];
  for (let i = 0; i < cutoff; i++) {
    const child = directChildren[i];
    if (!child) continue;
    if (child.type !== NodeType.turn) {
      // Any non-turn breaks the legacy prefix.
      if (fromIdx >= 0) break;
      continue;
    }
    const legacy = child.props.summary as string | undefined;
    if (legacy) {
      if (fromIdx < 0) fromIdx = i;
      toIdx = i + 1;
      legacyTexts.push(legacy);
    } else if (fromIdx >= 0) {
      // Prefix ends at the first non-legacy turn.
      break;
    }
  }
  if (fromIdx < 0 || toIdx <= fromIdx) return false;

  session.groupChildren(fromIdx, toIdx, () => ({
    type: NodeType.turnGroup,
    props: { depth: 1, stamp: LEGACY_STAMP },
    content: legacyTexts.join("\n"),
  }));
  return true;
}

// ── Step 2: depth-1 grouping ────────────────────────────────

async function formDepth1Group(
  session: Session,
  groupSize: number,
  keepRecentTurns: number,
  options: CompactOptions,
  stamp: string,
): Promise<TurnGroup | undefined> {
  const directChildren = session.children;
  const tailStart = Math.max(0, directChildren.length - keepRecentTurns);

  // Scan [0, tailStart) for the longest contiguous run of eligible raw
  // Turn children (not already grouped, not containing pinned descendants).
  let runStart = -1;
  let runEnd = -1;
  for (let i = 0; i < tailStart; i++) {
    const child = directChildren[i];
    if (!child) continue;
    if (child.type !== NodeType.turn) {
      runStart = -1;
      runEnd = -1;
      continue;
    }
    if (containsPinned(child, options.pinPolicy)) {
      // Close any in-progress run and skip.
      if (runStart >= 0 && runEnd - runStart > 0) {
        break;
      }
      runStart = -1;
      runEnd = -1;
      continue;
    }
    if (runStart < 0) runStart = i;
    runEnd = i + 1;
    if (runEnd - runStart >= groupSize) break;
  }

  if (runStart < 0 || runEnd <= runStart) return undefined;
  const fromIdx = runStart;
  const toIdx = Math.min(runEnd, runStart + groupSize);

  const turns: Turn[] = [];
  for (let i = fromIdx; i < toIdx; i++) {
    const c = directChildren[i];
    if (c && c.type === NodeType.turn) turns.push(c as Turn);
  }
  if (turns.length === 0) return undefined;

  // Summarise before forming the wrapper so we can bail if it fails.
  const summary = await options.summarizer.summarize({
    kind: "depth-1",
    turns,
  });

  const wrapper = session.groupChildren(fromIdx, toIdx, () => ({
    type: NodeType.turnGroup,
    props: {
      depth: 1,
      stamp,
      tokensEstimate: options.estimator.estimate(summary.content),
    },
    content: summary.content,
  })) as TurnGroup;
  if (summary.sections && summary.sections.length > 0) {
    wrapper.sections = summary.sections;
  }
  return wrapper;
}

// ── Step 3: depth promotion ─────────────────────────────────

async function promoteGroups(
  session: Session,
  threshold: number,
  keepRecentTurns: number,
  options: CompactOptions,
  stamp: string,
): Promise<TurnGroup | undefined> {
  const directChildren = session.children;
  const tailStart = Math.max(0, directChildren.length - keepRecentTurns);

  // Scan for the longest contiguous run of same-depth TurnGroup siblings.
  let runStart = -1;
  let runEnd = -1;
  let runDepth = -1;
  let bestStart = -1;
  let bestEnd = -1;
  let bestDepth = -1;
  for (let i = 0; i < tailStart; i++) {
    const child = directChildren[i];
    if (!child) continue;
    if (child.type !== NodeType.turnGroup) {
      if (runEnd - runStart > bestEnd - bestStart) {
        bestStart = runStart;
        bestEnd = runEnd;
        bestDepth = runDepth;
      }
      runStart = -1;
      runEnd = -1;
      runDepth = -1;
      continue;
    }
    const depth = (child as TurnGroup).depth;
    if (runStart < 0 || depth !== runDepth) {
      if (runEnd - runStart > bestEnd - bestStart) {
        bestStart = runStart;
        bestEnd = runEnd;
        bestDepth = runDepth;
      }
      runStart = i;
      runDepth = depth;
    }
    runEnd = i + 1;
  }
  if (runEnd - runStart > bestEnd - bestStart) {
    bestStart = runStart;
    bestEnd = runEnd;
    bestDepth = runDepth;
  }
  if (bestStart < 0 || bestEnd - bestStart < threshold) return undefined;

  const childGroups: TurnGroup[] = [];
  for (let i = bestStart; i < bestEnd; i++) {
    const c = directChildren[i];
    if (c && c.type === NodeType.turnGroup) childGroups.push(c as TurnGroup);
  }

  const summary = await options.summarizer.summarize({
    kind: "depth-k",
    children: childGroups,
    depth: bestDepth + 1,
  });

  const wrapper = session.groupChildren(bestStart, bestEnd, () => ({
    type: NodeType.turnGroup,
    props: {
      depth: bestDepth + 1,
      stamp,
      tokensEstimate: options.estimator.estimate(summary.content),
    },
    content: summary.content,
  })) as TurnGroup;
  if (summary.sections && summary.sections.length > 0) {
    wrapper.sections = summary.sections;
  }
  return wrapper;
}

// ── Helpers ─────────────────────────────────────────────────

/**
 * Rough pre-selection token estimate. Walks the session tree once, counting
 * raw turn content (with tool elision applied) and group summary content.
 * Used by the compactor to decide when to stop; not a substitute for
 * estimating the final ModelMessage[] projection.
 */
function estimateSession(
  session: Session,
  estimator: TokenEstimator,
  elisionPolicy: ToolElisionPolicy | undefined,
): number {
  let total = 0;
  for (const child of session.children) {
    total += estimateNode(child, estimator, elisionPolicy);
  }
  return total;
}

function estimateNode(
  node: TreeNode,
  estimator: TokenEstimator,
  elisionPolicy: ToolElisionPolicy | undefined,
): number {
  if (node.type === NodeType.turnGroup) {
    const group = node as TurnGroup;
    if (group.tokensEstimate > 0) return group.tokensEstimate;
    const content = group.summaryText ?? "";
    return estimator.estimate(content);
  }
  if (node.type === NodeType.turn) {
    return estimateTurn(node as Turn, estimator, elisionPolicy);
  }
  return estimator.estimate(node.content ?? "");
}

function estimateTurn(
  turn: Turn,
  estimator: TokenEstimator,
  elisionPolicy: ToolElisionPolicy | undefined,
): number {
  let total = 0;
  for (const child of turn.children) {
    if (child.type === NodeType.userMessage) {
      total += estimator.estimate((child as Message).text);
    } else if (child.type === NodeType.agentMessage) {
      total += estimator.estimate((child as Message).text ?? "");
    } else if (child.type === NodeType.toolCall) {
      const tc = child as ToolCall;
      total += estimator.estimate(JSON.stringify(tc.args ?? {}));
      const raw = tc.result ?? "";
      const projected = elisionPolicy
        ? elideToolResponse(raw, tc.toolName, tc.args, elisionPolicy)
        : raw;
      total += estimator.estimate(projected);
    }
  }
  return total;
}
