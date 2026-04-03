import { createEntry } from "./create-entry.js";
import { NodeType } from "./node-types.js";
import { TreeNode } from "./tree-node.js";
import type { NodeFactory, TreeEntry } from "./types.js";

const MESSAGE_TYPES: Set<string> = new Set([
  NodeType.userMessage,
  NodeType.agentMessage,
  NodeType.thinking,
  NodeType.text,
]);

// ─── Session ────────────────────────────────────────────────────

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

// ─── Turn ───────────────────────────────────────────────────────

export interface Usage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}

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

// ─── Message ────────────────────────────────────────────────────

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

// ─── ToolCall ───────────────────────────────────────────────────

export class ToolCall extends TreeNode {
  get callId(): string {
    return this.props.callId as string;
  }

  get toolName(): string {
    return this.props.toolName as string;
  }

  get request(): TreeNode | undefined {
    return this.childrenOfType(NodeType.toolRequest)[0];
  }

  get response(): TreeNode | undefined {
    return this.childrenOfType(NodeType.toolResponse)[0];
  }

  get args(): unknown {
    return this.request?.props.args;
  }

  get result(): string | undefined {
    return this.response?.content;
  }

  get isError(): boolean {
    return (this.response?.props.isError as boolean) ?? false;
  }

  get progressText(): string | undefined {
    return this.props.progressText as string | undefined;
  }

  set progressText(text: string | undefined) {
    this.props.progressText = text;
    this.notify();
  }

  addResponse(text: string, isError = false): TreeNode {
    const entry = createEntry({
      type: NodeType.toolResponse,
      content: text,
      props: { callId: this.callId, toolName: this.toolName, isError },
    });
    return this.addChild(entry);
  }

  appendUpdate(text: string): void {
    const resp = this.response;
    if (resp) {
      resp.content = text;
      resp.touch();
    }
  }
}

// ─── Default agent factory ──────────────────────────────────────

/**
 * Create a node factory from a type → constructor index.
 * Unknown types fall back to plain TreeNode.
 */
export function newNodeFactory(
  index: Record<
    string,
    new (
      data: TreeEntry,
      factory: NodeFactory,
    ) => TreeNode
  >,
): NodeFactory {
  const factory: NodeFactory = (data: TreeEntry) => {
    const type = (data.props.type as string) ?? "message";
    const Ctor = index[type] ?? TreeNode;
    return new Ctor(data, factory);
  };
  return factory;
}

/**
 * Create the default agent node factory.
 * Maps known types to typed wrappers (Session, Turn, Message, ToolCall).
 */
export function createAgentNodeFactory(): NodeFactory {
  return newNodeFactory({
    [NodeType.session]: Session,
    [NodeType.turn]: Turn,
    [NodeType.userMessage]: Message,
    [NodeType.agentMessage]: Message,
    [NodeType.thinking]: Message,
    [NodeType.text]: Message,
    [NodeType.toolCall]: ToolCall,
  });
}
