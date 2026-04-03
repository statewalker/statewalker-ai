import { createEntry } from "../create-entry.js";
import { NodeType } from "../node-types.js";
import { TreeNode } from "../tree-node.js";

export class Message extends TreeNode {
  get role(): string {
    switch (this.type) {
      case NodeType.userMessage:
        return "user";
      case NodeType.agentMessage:
        return "assistant";
      case NodeType.thinking:
        return "thinking";
      default:
        return this.type;
    }
  }

  get text(): string {
    return this.content ?? "";
  }

  appendDelta(delta: string): void {
    this.content = (this.content ?? "") + delta;
    this.touch();
  }

  get thinkingBlocks(): Message[] {
    return this.childrenOfType(NodeType.thinking) as Message[];
  }

  addThinkingBlock(): Message {
    const entry = createEntry({ type: NodeType.thinking, content: "" });
    return this.addChild(entry) as Message;
  }
}
