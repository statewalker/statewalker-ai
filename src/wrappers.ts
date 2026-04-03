import { BaseClass } from "@repo/shared/models";
import { TreeEntry } from "./tree-entry.js";

// ─── Node types used across wrappers ────────────────────────────

export const NodeType = {
  session: "session",
  turn: "turn",
  userMessage: "user_message",
  agentMessage: "agent_message",
  thinking: "thinking",
  text: "text",
  toolCall: "tool_call",
  toolRequest: "tool_request",
  toolResponse: "tool_response",
  error: "error",
  inputRejected: "input_rejected",
} as const;

const MESSAGE_TYPES: Set<string> = new Set([
  NodeType.userMessage,
  NodeType.agentMessage,
  NodeType.thinking,
  NodeType.text,
]);

// ─── Base wrapper ───────────────────────────────────────────────

export class TreeNodeWrapper extends BaseClass {
  constructor(readonly entry: TreeEntry) {
    super();
  }

  get id(): string {
    return this.entry.id;
  }

  get type(): string {
    return this.entry.type;
  }

  get props(): Record<string, unknown> {
    return this.entry.props;
  }

  get content(): string | undefined {
    return this.entry.content;
  }

  protected childrenOfType(type: string): TreeEntry[] {
    return this.entry.children?.filter((c) => c.type === type) ?? [];
  }
}

// ─── SessionView ────────────────────────────────────────────────

export class SessionView extends TreeNodeWrapper {
  get turns(): TurnView[] {
    return this.childrenOfType(NodeType.turn).map((e) => new TurnView(e));
  }

  get currentTurn(): TurnView | undefined {
    const turns = this.childrenOfType(NodeType.turn);
    const last = turns[turns.length - 1];
    return last ? new TurnView(last) : undefined;
  }

  addTurn(props?: Record<string, unknown>): TurnView {
    const turn = new TreeEntry({ type: NodeType.turn, props });
    this.entry.addChild(turn);
    this.notify();
    return new TurnView(turn);
  }
}

// ─── TurnView ───────────────────────────────────────────────────

export interface Usage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}

export class TurnView extends TreeNodeWrapper {
  get turnNumber(): number {
    return (this.entry.props.turnNumber as number) ?? 0;
  }

  get stopReason(): string | undefined {
    return this.entry.props.stopReason as string | undefined;
  }

  set stopReason(value: string | undefined) {
    this.entry.props.stopReason = value;
    this.entry.touch();
  }

  get model(): string | undefined {
    return this.entry.props.model as string | undefined;
  }

  set model(value: string | undefined) {
    this.entry.props.model = value;
  }

  get usage(): Usage | undefined {
    return this.entry.props.usage as Usage | undefined;
  }

  set usage(value: Usage | undefined) {
    this.entry.props.usage = value;
  }

  get messages(): MessageView[] {
    return (this.entry.children ?? [])
      .filter((c) => MESSAGE_TYPES.has(c.type))
      .map((e) => new MessageView(e));
  }

  get toolCalls(): ToolCallView[] {
    return this.childrenOfType(NodeType.toolCall).map(
      (e) => new ToolCallView(e),
    );
  }

  get errors(): TreeEntry[] {
    return this.childrenOfType(NodeType.error);
  }

  addUserMessage(text: string): MessageView {
    const msg = new TreeEntry({ type: NodeType.userMessage, content: text });
    this.entry.addChild(msg);
    this.notify();
    return new MessageView(msg);
  }

  addAgentMessage(): MessageView {
    const msg = new TreeEntry({ type: NodeType.agentMessage, content: "" });
    this.entry.addChild(msg);
    this.notify();
    return new MessageView(msg);
  }

  addToolCall(callId: string, toolName: string, args?: unknown): ToolCallView {
    const tc = new TreeEntry({
      type: NodeType.toolCall,
      props: { callId, toolName },
    });
    this.entry.addChild(tc);

    const req = new TreeEntry({
      type: NodeType.toolRequest,
      props: { callId, toolName, args },
    });
    tc.addChild(req);

    this.notify();
    return new ToolCallView(tc);
  }
}

// ─── MessageView ────────────────────────────────────────────────

export class MessageView extends TreeNodeWrapper {
  get role(): string {
    switch (this.entry.type) {
      case NodeType.userMessage:
        return "user";
      case NodeType.agentMessage:
        return "assistant";
      case NodeType.thinking:
        return "thinking";
      default:
        return this.entry.type;
    }
  }

  get text(): string {
    return this.entry.content ?? "";
  }

  appendDelta(delta: string): void {
    this.entry.content = (this.entry.content ?? "") + delta;
    this.entry.touch();
    this.notify();
  }

  get thinkingBlocks(): MessageView[] {
    return this.childrenOfType(NodeType.thinking).map(
      (e) => new MessageView(e),
    );
  }

  addThinkingBlock(): MessageView {
    const block = new TreeEntry({ type: NodeType.thinking, content: "" });
    this.entry.addChild(block);
    this.notify();
    return new MessageView(block);
  }
}

// ─── ToolCallView ───────────────────────────────────────────────

export class ToolCallView extends TreeNodeWrapper {
  get callId(): string {
    return this.entry.props.callId as string;
  }

  get toolName(): string {
    return this.entry.props.toolName as string;
  }

  get request(): TreeEntry | undefined {
    return this.childrenOfType(NodeType.toolRequest)[0];
  }

  get response(): TreeEntry | undefined {
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
    return this.entry.props.progressText as string | undefined;
  }

  set progressText(text: string | undefined) {
    this.entry.props.progressText = text;
    this.entry.notify();
  }

  addResponse(text: string, isError = false): TreeEntry {
    const resp = new TreeEntry({
      type: NodeType.toolResponse,
      content: text,
      props: {
        callId: this.callId,
        toolName: this.toolName,
        isError,
      },
    });
    this.entry.addChild(resp);
    this.notify();
    return resp;
  }

  appendUpdate(text: string): void {
    const resp = this.response;
    if (resp) {
      resp.content = text;
      resp.touch();
    }
  }
}
