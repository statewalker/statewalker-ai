import { createEntry } from "../create-entry.js";
import { NodeType } from "../node-types.js";
import { TreeNode } from "../tree-node.js";
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
    const entry = createEntry({ type: NodeType.turn, props });
    return this.addChild(entry) as Turn;
  }
}
