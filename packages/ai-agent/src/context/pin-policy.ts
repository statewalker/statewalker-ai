import { NodeType } from "../state/node-types.js";
import type { Session } from "../state/session.js";
import type { ToolCall } from "../state/tool-call.js";
import type { TreeNode } from "../state/tree-node.js";

/**
 * Predicate describing whether a given node is "pinned" — must never be
 * elided by the tool-result elision pass and must cause its enclosing
 * `TurnGroup` to be expanded rather than summarised by the hierarchical
 * selector.
 */
export interface PinPolicy {
  /**
   * A one-time preparation the policy may run over the session before each
   * selection pass (e.g. scan for the latest user message). Optional.
   */
  prepare?(session: Session): void;
  shouldPin(node: TreeNode): boolean;
}

export type PinPredicate = (node: TreeNode) => boolean;

export interface CreatePinPolicyOptions {
  predicates: PinPredicate[];
  prepare?(session: Session): void;
}

/**
 * Compose a set of predicates with logical OR. `shouldPin` returns true for
 * a node when any predicate does.
 */
export function createPinPolicy(options: CreatePinPolicyOptions): PinPolicy {
  const preds = options.predicates;
  return {
    prepare: options.prepare,
    shouldPin(node) {
      for (const p of preds) {
        if (p(node)) return true;
      }
      return false;
    },
  };
}

export interface DefaultPinPolicyOptions {
  /**
   * Tool names whose most-recent call should be pinned (their outputs are
   * stateful and used downstream). Defaults to list_tools / list_skills /
   * use_skills.
   */
  pinStatefulTools?: string[];
  /** Additional predicates OR-ed with the defaults. */
  additionalPredicates?: PinPredicate[];
}

/**
 * Build the package default pin policy:
 *  - latest `user_message` across all turns (including those inside groups),
 *  - latest `tool_call` per stateful-tool name,
 *  - any node with `props.pinned === true`,
 *  - any caller-supplied `additionalPredicates`.
 */
export function createDefaultPinPolicy(options: DefaultPinPolicyOptions = {}): PinPolicy {
  const statefulTools = new Set(
    options.pinStatefulTools ?? ["list_tools", "list_skills", "use_skills"],
  );
  const additional = options.additionalPredicates ?? [];

  // Populated per `prepare(session)` call; `shouldPin` tests membership.
  let pinnedLatestUserMessage: TreeNode | undefined;
  const pinnedLatestStatefulCalls = new Map<string, TreeNode>();

  const prepare = (session: Session): void => {
    pinnedLatestUserMessage = undefined;
    pinnedLatestStatefulCalls.clear();

    const turns = session.allTurns();
    for (let i = turns.length - 1; i >= 0; i--) {
      const turn = turns[i];
      if (!turn) continue;
      if (!pinnedLatestUserMessage) {
        for (const child of turn.children) {
          if (child.type === NodeType.userMessage) {
            pinnedLatestUserMessage = child;
            break;
          }
        }
      }
      if (pinnedLatestUserMessage) break;
    }

    for (const turn of turns) {
      for (const child of turn.children) {
        if (child.type !== NodeType.toolCall) continue;
        const name = (child as ToolCall).toolName;
        if (statefulTools.has(name)) {
          pinnedLatestStatefulCalls.set(name, child);
        }
      }
    }
  };

  const shouldPin: PinPredicate = (node) => {
    if (node.props.pinned === true) return true;
    if (pinnedLatestUserMessage && node.id === pinnedLatestUserMessage.id) {
      return true;
    }
    if (node.type === NodeType.toolCall) {
      const latest = pinnedLatestStatefulCalls.get((node as ToolCall).toolName);
      if (latest && latest.id === node.id) return true;
    }
    for (const p of additional) {
      if (p(node)) return true;
    }
    return false;
  };

  return {
    prepare,
    shouldPin,
  };
}

/**
 * Walk a subtree and return whether the policy pins the node itself or any
 * descendant. Used by the hierarchical selector to force `TurnGroup`
 * expansion and by the compactor to skip pinned-containing runs when
 * forming new groups.
 */
export function containsPinned(node: TreeNode, pin: PinPolicy): boolean {
  if (pin.shouldPin(node)) return true;
  for (const child of node.children) {
    if (containsPinned(child, pin)) return true;
  }
  return false;
}
