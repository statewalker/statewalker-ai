import { createEntry } from "../create-entry.js";
import { NodeType } from "../node-types.js";
import { TreeNode } from "../tree-node.js";
import type { Message } from "./message.js";
import type { ToolCall } from "./tool-call.js";

export interface Usage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}

const MESSAGE_TYPES: Set<string> = new Set([
  NodeType.userMessage,
  NodeType.agentMessage,
  NodeType.thinking,
  NodeType.text,
]);

export class Turn extends TreeNode {
  get turnNumber(): number {
    return (this.props.turnNumber as number) ?? 0;
  }

  get stopReason(): string | undefined {
    return this.props.stopReason as string | undefined;
  }

  set stopReason(value: string | undefined) {
    this.props.stopReason = value;
    this.touch();
  }

  get model(): string | undefined {
    return this.props.model as string | undefined;
  }

  set model(value: string | undefined) {
    this.props.model = value;
  }

  get usage(): Usage | undefined {
    return this.props.usage as Usage | undefined;
  }

  set usage(value: Usage | undefined) {
    this.props.usage = value;
  }

  get messages(): Message[] {
    return this.children.filter((c) => MESSAGE_TYPES.has(c.type)) as Message[];
  }

  get toolCalls(): ToolCall[] {
    return this.childrenOfType(NodeType.toolCall) as ToolCall[];
  }

  get errors(): TreeNode[] {
    return this.childrenOfType(NodeType.error);
  }

  addUserMessage(text: string): Message {
    const entry = createEntry({ type: NodeType.userMessage, content: text });
    return this.addChild(entry) as Message;
  }

  addAgentMessage(): Message {
    const entry = createEntry({ type: NodeType.agentMessage, content: "" });
    return this.addChild(entry) as Message;
  }

  addToolCall(callId: string, toolName: string, args?: unknown): ToolCall {
    const tcEntry = createEntry({
      type: NodeType.toolCall,
      props: { callId, toolName },
    });
    const tc = this.addChild(tcEntry) as ToolCall;

    const reqEntry = createEntry({
      type: NodeType.toolRequest,
      props: { callId, toolName, args },
    });
    tc.addChild(reqEntry);

    return tc;
  }
}
