import { TreeNode } from "../tree-node.js";
import { NodeType } from "./node-types.js";

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
    return this.addChild({
      type: NodeType.thinking,
      content: "",
    }) as Message;
  }
}
