import type { LogMessage } from "./log-message.js";
import { NodeType } from "./node-types.js";
import { TreeNode } from "./tree-node.js";
import type { Turn } from "./turn.js";

/**
 * The persistable state of one Session — the tree of `Turn`s, `Message`s,
 * `ToolCall`s, and `TurnGroup`s. Pure data; a typed view over `TreeNode`.
 *
 * The runtime-side {@link import("../runtime/session.js").Session} holds an
 * instance as its `.state` field; it is the orchestrator that drives the
 * model loop. This class is just the data.
 */
export class SessionState extends TreeNode {
  isStreaming = false;
  error = "";

  get title(): string | undefined {
    return this.props.title as string | undefined;
  }

  set title(value: string | undefined) {
    this.props.title = value;
    this.touch();
  }

  /**
   * Direct `Turn` children only (non-recursive). One inbox message → one
   * new turn at the root's end (invariant of the agent loop).
   */
  get turns(): Turn[] {
    return this.childrenOfType(NodeType.turn) as Turn[];
  }

  /**
   * Every raw `Turn` descendant in document order, recursing through any
   * `TurnGroup` wrappers introduced by context compaction.
   */
  allTurns(): Turn[] {
    const out: Turn[] = [];
    collectTurns(this, out);
    return out;
  }

  get currentTurn(): Turn | undefined {
    const turns = this.turns;
    return turns[turns.length - 1];
  }

  addTurn(props?: Record<string, unknown>): Turn {
    return this.addChild({ type: NodeType.turn, props }) as Turn;
  }

  startStreaming(): void {
    this.isStreaming = true;
    this.error = "";
    this.notify();
  }

  stopStreaming(error?: unknown): void {
    this.isStreaming = false;
    if (error !== undefined) {
      this.error = error instanceof Error ? error.message : String(error);
    }
    this.notify();
  }

  async *runTurn(
    text: string,
    handleTurn: (turn: Turn) => AsyncGenerator<LogMessage>,
  ): AsyncGenerator<LogMessage> {
    this.startStreaming();
    let error: unknown;
    try {
      const turn = this.addTurn();
      turn.addUserMessage(text);
      yield* handleTurn(turn);
    } catch (e) {
      error = e;
      const turnId = this.currentTurn?.id ?? "";
      yield {
        type: "error",
        turnId,
        message: e instanceof Error ? e.message : String(e),
      };
    } finally {
      this.stopStreaming(error);
    }
  }
}

function collectTurns(node: TreeNode, out: Turn[]): void {
  for (const child of node.children) {
    if (child.type === NodeType.turn) {
      out.push(child as Turn);
    } else if (child.type === NodeType.turnGroup) {
      collectTurns(child, out);
    }
  }
}

/**
 * @deprecated Renamed to {@link SessionState}. The alias is kept for one
 * cycle to let external consumers migrate; it will be removed in a future
 * change. Update imports to `SessionState`.
 */
export { SessionState as Session };
