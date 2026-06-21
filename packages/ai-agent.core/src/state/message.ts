import { NodeType } from "./node-types.js";
import { TreeNode } from "./tree-node.js";

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

  /** Build assistant content parts for ModelMessage reconstruction. */
  toAssistantParts(): Record<string, unknown>[] {
    const parts: Record<string, unknown>[] = [];

    for (const block of this.thinkingBlocks) {
      const part: Record<string, unknown> = {
        type: "reasoning",
        text: block.text,
      };
      if (block.props.providerMetadata) {
        part.providerOptions = block.props.providerMetadata;
      }
      parts.push(part);
    }

    if (this.text) {
      const part: Record<string, unknown> = { type: "text", text: this.text };
      if (this.props.providerMetadata) {
        part.providerOptions = this.props.providerMetadata;
      }
      parts.push(part);
    }

    return parts;
  }
}
