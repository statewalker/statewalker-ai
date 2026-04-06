import { TreeNode } from "@statewalker/ai-agent-state";
import type { ModelMessage } from "ai";
import type { LogMessage } from "./log-message.js";
import type { Message } from "./message.js";
import { NodeType } from "./node-types.js";
import type { ToolCall } from "./tool-call.js";

export interface Usage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}

/** Any stream event part — has a `type` and arbitrary fields. */
export type StreamPart = { type: string; [key: string]: unknown };

const MESSAGE_TYPES: Set<string> = new Set([
  NodeType.userMessage,
  NodeType.agentMessage,
  NodeType.thinking,
  NodeType.text,
]);

export class Turn extends TreeNode {
  // ── Transient streaming state ──────────────────────────────
  // Maps stream-part id → tree node for finding parent nodes
  // during streaming. Cleared on step-finish.
  private _active = new Map<string, TreeNode>();

  // ── Properties ─────────────────────────────────────────────

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
    this.touch();
  }

  get usage(): Usage | undefined {
    return this.props.usage as Usage | undefined;
  }

  set usage(value: Usage | undefined) {
    this.props.usage = value;
    this.touch();
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

  // ── Node creation ──────────────────────────────────────────

  addUserMessage(text: string): Message {
    return this.addChild({
      type: NodeType.userMessage,
      content: text,
    }) as Message;
  }

  addAgentMessage(): Message {
    return this.addChild({
      type: NodeType.agentMessage,
      content: "",
    }) as Message;
  }

  addToolCall(callId: string, toolName: string, args?: unknown): ToolCall {
    const tc = this.addChild({
      type: NodeType.toolCall,
      props: { callId, toolName },
    }) as ToolCall;

    tc.addChild({
      type: NodeType.toolRequest,
      props: { callId, toolName, args },
    });

    return tc;
  }

  addToolResponse(callId: string, result: unknown, isError = false): void {
    const tc = this.toolCalls.find((t) => t.callId === callId);
    if (!tc) return;
    const text = typeof result === "string" ? result : JSON.stringify(result);
    tc.addResponse(text, isError);
  }

  stop(reason: string): void {
    this.stopReason = reason;
  }

  // ── Summary (cached on node props) ─────────────────────────

  get summary(): string | undefined {
    return this.props.summary as string | undefined;
  }

  set summary(value: string | undefined) {
    this.props.summary = value;
    this.touch();
  }

  /** Collect plain text for summarization. */
  toPlainText(): string {
    const parts: string[] = [];
    for (const child of this.children) {
      if (child.type === NodeType.userMessage) {
        parts.push(`User: ${(child as Message).text}`);
      } else if (child.type === NodeType.agentMessage) {
        const text = (child as Message).text;
        if (text) parts.push(`Assistant: ${text}`);
      }
    }
    return parts.join("\n");
  }

  // ── ModelMessage reconstruction ────────────────────────────

  /** Build ModelMessage array from this turn's children. */
  toModelMessages(): ModelMessage[] {
    const result: ModelMessage[] = [];
    const agentMessages: Message[] = [];
    const toolCalls: ToolCall[] = [];

    for (const child of this.children) {
      switch (child.type) {
        case NodeType.userMessage:
          result.push({ role: "user", content: (child as Message).text });
          break;
        case NodeType.agentMessage:
          agentMessages.push(child as Message);
          break;
        case NodeType.toolCall:
          toolCalls.push(child as ToolCall);
          break;
      }
    }

    if (agentMessages.length === 0 && toolCalls.length === 0) return result;

    const parts: Record<string, unknown>[] = [];
    for (const msg of agentMessages) {
      parts.push(...msg.toAssistantParts());
    }
    for (const tc of toolCalls) {
      parts.push(tc.toAssistantPart());
    }
    if (parts.length > 0) {
      result.push({ role: "assistant", content: parts } as ModelMessage);
    }

    for (const tc of toolCalls) {
      const msg = tc.toResultMessage();
      if (msg) result.push(msg);
    }

    return result;
  }

  // ── Stream event handlers ──────────────────────────────────
  // Each returns a LogMessage if the event is worth logging.
  // The caller (stream processor) yields these as they come.

  handleText(part: StreamPart): LogMessage | undefined {
    const { type } = part;
    const id = part.id as string;
    if (type === "text-start") {
      const msg = this._ensureAgentMsg();
      this._active.set(id, msg);
      copyMetadata(msg.props, part);
      return undefined;
    }
    if (type === "text-delta") {
      const text = part.text as string;
      (this._active.get(id) as Message | undefined)?.appendDelta(text);
      return { type: "text-delta", turnId: this.id, text };
    }
    // text-end
    this._active.delete(id);
    return undefined;
  }

  handleReasoning(part: StreamPart): LogMessage | undefined {
    const { type } = part;
    const id = part.id as string;
    if (type === "reasoning-start") {
      const agentMsg = this._ensureAgentMsg();
      const thinking = agentMsg.addThinkingBlock();
      this._active.set(id, thinking);
      copyMetadata(thinking.props, part);
      return undefined;
    }
    if (type === "reasoning-delta") {
      const text = part.text as string;
      (this._active.get(id) as Message | undefined)?.appendDelta(text);
      return { type: "reasoning", turnId: this.id, text };
    }
    // reasoning-end
    this._active.delete(id);
    return undefined;
  }

  handleToolInput(part: StreamPart): LogMessage | undefined {
    const { type } = part;
    const callId = (part.id as string) ?? `tool-input-${Date.now()}`;
    if (type === "tool-input-start") {
      const tc = this.addToolCall(callId, part.toolName as string);
      copyMetadata(tc.props, part);
      return {
        type: "tool-call",
        turnId: this.id,
        toolCallId: tc.callId,
        toolName: tc.toolName,
        args: undefined,
      };
    }
    if (type === "tool-input-delta") {
      const tc = this.toolCalls.find((t) => t.callId === callId);
      if (tc) {
        const req = tc.request;
        if (req) {
          req.content = (req.content ?? "") + (part.delta as string);
          req.touch();
        }
      }
      return undefined;
    }
    // tool-input-end — no action
    return undefined;
  }

  handleTool(part: StreamPart): LogMessage | undefined {
    const { type } = part;
    if (type === "tool-call") {
      const toolCallId = part.toolCallId as string;
      const toolName = part.toolName as string;
      const input = part.input as Record<string, unknown>;
      const tc = this.addToolCall(toolCallId, toolName, input);
      copyMetadata(tc.props, part);
      return {
        type: "tool-call",
        turnId: this.id,
        toolCallId,
        toolName,
        args: input,
      };
    }
    if (type === "tool-result") {
      const callId = part.toolCallId as string;
      this.addToolResponse(callId, part.output);
      return {
        type: "tool-result",
        turnId: this.id,
        toolCallId: callId,
        toolName: part.toolName as string,
        result: part.output,
      };
    }
    if (type === "tool-error") {
      const callId = part.toolCallId as string;
      const tc = this.toolCalls.find((t) => t.callId === callId);
      if (tc) {
        tc.addResponse(
          part.error instanceof Error ? part.error.message : String(part.error),
          true,
        );
      }
      return undefined;
    }
    if (type === "tool-output-denied") {
      this.addChild({
        type: NodeType.toolOutputDenied,
        props: { toolCallId: part.toolCallId, toolName: part.toolName },
      });
      return undefined;
    }
    return undefined;
  }

  handleFinishStep(part: StreamPart): LogMessage {
    const reason = part.finishReason as string;
    this.stop(reason);
    this._active.clear();

    // Accumulate per-step usage (SDK sends { promptTokens, completionTokens })
    const stepUsage = part.usage as
      | { promptTokens?: number; completionTokens?: number }
      | undefined;
    if (stepUsage) {
      const prev = this.usage ?? { input: 0, output: 0 };
      this.usage = {
        input: prev.input + (stepUsage.promptTokens ?? 0),
        output: prev.output + (stepUsage.completionTokens ?? 0),
      };
    }

    return { type: "step-finish", turnId: this.id, finishReason: reason };
  }

  /** Handle stream finish — sets authoritative total usage. */
  handleFinish(part: StreamPart): void {
    const totalUsage = part.totalUsage as
      | { promptTokens?: number; completionTokens?: number }
      | undefined;
    if (totalUsage) {
      this.usage = {
        input: totalUsage.promptTokens ?? 0,
        output: totalUsage.completionTokens ?? 0,
      };
    }
  }

  handleError(part: StreamPart): LogMessage {
    const msg =
      part.error instanceof Error ? part.error.message : String(part.error);
    this.addChild({ type: NodeType.error, content: msg });
    return { type: "error", turnId: this.id, message: msg };
  }

  handleMetadata(part: StreamPart): void {
    this.addChild({ type: part.type, props: { ...part } });
  }

  /** Get or create the current step's agent message. */
  private _ensureAgentMsg(): Message {
    let msg = this._active.get("$agentMsg") as Message | undefined;
    if (!msg) {
      msg = this.addAgentMessage();
      this._active.set("$agentMsg", msg);
    }
    return msg;
  }
}

function copyMetadata(props: Record<string, unknown>, part: StreamPart): void {
  if (part.providerMetadata) {
    props.providerMetadata = part.providerMetadata;
  }
}
