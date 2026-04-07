import { TreeNode } from "@statewalker/ai-agent-state";
import type { LogMessage } from "./log-message.js";
import { NodeType } from "./node-types.js";
import type { Turn } from "./turn.js";

export class Session extends TreeNode {
  isStreaming = false;
  error = "";

  get title(): string | undefined {
    return this.props.title as string | undefined;
  }

  set title(value: string | undefined) {
    this.props.title = value;
    this.touch();
  }

  get turns(): Turn[] {
    return this.childrenOfType(NodeType.turn) as Turn[];
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
