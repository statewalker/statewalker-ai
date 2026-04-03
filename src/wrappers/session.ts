import { TreeNode } from "@statewalker/ai-agent-state";
import { NodeType } from "./node-types.js";
import type { Turn } from "./turn.js";

export class Session extends TreeNode {
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
}
