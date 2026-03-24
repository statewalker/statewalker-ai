/**
 * Agent event types — structurally compatible with ContentMessage from
 * @repo/content-blocks without importing it.
 *
 * Shape: { props: { time, role, type, ...extra }, blocks: [{ content }] }
 *
 * All prop values are `string | undefined` (content-blocks constraint).
 * Structured data (args, details) goes in blocks[0].content as JSON.
 * This means any AgentEvent can be serialized/parsed using
 * content-blocks' serializeDocument/parseDocument infrastructure.
 */

// ---------------------------------------------------------------------------
// Base shapes (structurally identical to content-blocks types)
// ---------------------------------------------------------------------------

/** Structurally compatible with ContentBlock from content-blocks. */
export interface EventBlock {
  id?: string;
  title?: string;
  content: string;
  children?: EventBlock[];
}

/** Structurally compatible with ContentProps from content-blocks. */
export interface EventProps {
  id?: string;
  [key: string]: string | undefined;
}

/** Structurally compatible with ContentMessageProps from content-blocks. */
export interface AgentEventProps extends EventProps {
  time: string;
  role: string;
  type: AgentEventType;
}

// ---------------------------------------------------------------------------
// Event type discriminant
// ---------------------------------------------------------------------------

export type AgentEventType =
  | "agent:start"
  | "agent:end"
  | "agent:turn-start"
  | "agent:turn-end"
  | "agent:assistant"
  | "agent:text-delta"
  | "agent:thinking-delta"
  | "agent:tool-call"
  | "agent:tool-result"
  | "agent:tool-update"
  | "agent:tool-progress"
  | "agent:input-rejected"
  | "agent:error";

// ---------------------------------------------------------------------------
// Per-event prop interfaces
// ---------------------------------------------------------------------------

export interface AgentStartProps extends AgentEventProps {
  type: "agent:start";
  role: "system";
}

export interface AgentEndProps extends AgentEventProps {
  type: "agent:end";
  role: "system";
}

export interface AgentTurnStartProps extends AgentEventProps {
  type: "agent:turn-start";
  role: "system";
  turnNumber: string;
}

export interface AgentTurnEndProps extends AgentEventProps {
  type: "agent:turn-end";
  role: "system";
  stopReason?: string;
  model?: string;
}

export interface AgentAssistantProps extends AgentEventProps {
  type: "agent:assistant";
  role: "assistant";
}

export interface AgentTextDeltaProps extends AgentEventProps {
  type: "agent:text-delta";
  role: "assistant";
}

export interface AgentThinkingDeltaProps extends AgentEventProps {
  type: "agent:thinking-delta";
  role: "assistant";
}

export interface AgentToolCallProps extends AgentEventProps {
  type: "agent:tool-call";
  role: "assistant";
  toolCallId: string;
  toolName: string;
}

export interface AgentToolResultProps extends AgentEventProps {
  type: "agent:tool-result";
  role: "tool";
  toolCallId: string;
  toolName: string;
  isError?: string;
}

export interface AgentToolUpdateProps extends AgentEventProps {
  type: "agent:tool-update";
  role: "tool";
  toolCallId: string;
  toolName: string;
  isError?: string;
}

export interface AgentToolProgressProps extends AgentEventProps {
  type: "agent:tool-progress";
  role: "tool";
  toolCallId: string;
  toolName: string;
}

export interface AgentInputRejectedProps extends AgentEventProps {
  type: "agent:input-rejected";
  role: "system";
}

export interface AgentErrorProps extends AgentEventProps {
  type: "agent:error";
  role: "system";
}

// ---------------------------------------------------------------------------
// Per-event message types (structurally compatible with ContentMessage)
// ---------------------------------------------------------------------------

export interface AgentStartEvent {
  props: AgentStartProps;
  blocks: EventBlock[];
}

export interface AgentEndEvent {
  props: AgentEndProps;
  blocks: EventBlock[];
}

export interface AgentTurnStartEvent {
  props: AgentTurnStartProps;
  blocks: EventBlock[];
}

export interface AgentTurnEndEvent {
  props: AgentTurnEndProps;
  blocks: EventBlock[];
}

export interface AgentAssistantEvent {
  props: AgentAssistantProps;
  blocks: EventBlock[];
}

export interface AgentTextDeltaEvent {
  props: AgentTextDeltaProps;
  blocks: EventBlock[];
}

export interface AgentThinkingDeltaEvent {
  props: AgentThinkingDeltaProps;
  blocks: EventBlock[];
}

export interface AgentToolCallEvent {
  props: AgentToolCallProps;
  blocks: EventBlock[];
}

export interface AgentToolResultEvent {
  props: AgentToolResultProps;
  blocks: EventBlock[];
}

export interface AgentToolUpdateEvent {
  props: AgentToolUpdateProps;
  blocks: EventBlock[];
}

export interface AgentToolProgressEvent {
  props: AgentToolProgressProps;
  blocks: EventBlock[];
}

export interface AgentInputRejectedEvent {
  props: AgentInputRejectedProps;
  blocks: EventBlock[];
}

export interface AgentErrorEvent {
  props: AgentErrorProps;
  blocks: EventBlock[];
}

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

export type AgentEvent =
  | AgentStartEvent
  | AgentEndEvent
  | AgentTurnStartEvent
  | AgentTurnEndEvent
  | AgentAssistantEvent
  | AgentTextDeltaEvent
  | AgentThinkingDeltaEvent
  | AgentToolCallEvent
  | AgentToolResultEvent
  | AgentToolUpdateEvent
  | AgentToolProgressEvent
  | AgentInputRejectedEvent
  | AgentErrorEvent;

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

function now(): string {
  return new Date().toISOString();
}

function msg<P extends AgentEventProps>(
  props: P,
  content = "",
): { props: P; blocks: EventBlock[] } {
  return { props, blocks: [{ content }] };
}

export function agentStart(): AgentStartEvent {
  return msg({ type: "agent:start", role: "system", time: now() });
}

export function agentEnd(): AgentEndEvent {
  return msg({ type: "agent:end", role: "system", time: now() });
}

export function agentTurnStart(turnNumber: number): AgentTurnStartEvent {
  return msg({
    type: "agent:turn-start",
    role: "system",
    time: now(),
    turnNumber: String(turnNumber),
  });
}

export function agentTurnEnd(
  stopReason?: string,
  model?: string,
): AgentTurnEndEvent {
  return msg({
    type: "agent:turn-end",
    role: "system",
    time: now(),
    stopReason,
    model,
  });
}

export function agentAssistant(): AgentAssistantEvent {
  return msg({ type: "agent:assistant", role: "assistant", time: now() });
}

export function agentTextDelta(delta: string): AgentTextDeltaEvent {
  return msg(
    { type: "agent:text-delta", role: "assistant", time: now() },
    delta,
  );
}

export function agentThinkingDelta(delta: string): AgentThinkingDeltaEvent {
  return msg(
    { type: "agent:thinking-delta", role: "assistant", time: now() },
    delta,
  );
}

export function agentToolCall(call: {
  toolCallId: string;
  toolName: string;
  args: unknown;
}): AgentToolCallEvent {
  return msg(
    {
      type: "agent:tool-call",
      role: "assistant",
      time: now(),
      toolCallId: call.toolCallId,
      toolName: call.toolName,
    },
    JSON.stringify(call.args),
  );
}

export function agentToolResult(result: {
  toolCallId: string;
  toolName: string;
  text: string;
  isError?: boolean;
  details?: unknown;
}): AgentToolResultEvent {
  const content = result.details
    ? JSON.stringify({ text: result.text, details: result.details })
    : result.text;
  return msg(
    {
      type: "agent:tool-result",
      role: "tool",
      time: now(),
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      isError: result.isError ? "true" : undefined,
    },
    content,
  );
}

export function agentToolUpdate(update: {
  toolCallId: string;
  toolName: string;
  text: string;
  isError?: boolean;
}): AgentToolUpdateEvent {
  return msg(
    {
      type: "agent:tool-update",
      role: "tool",
      time: now(),
      toolCallId: update.toolCallId,
      toolName: update.toolName,
      isError: update.isError ? "true" : undefined,
    },
    update.text,
  );
}

export function agentToolProgress(info: {
  toolCallId: string;
  toolName: string;
  text: string;
}): AgentToolProgressEvent {
  return msg(
    {
      type: "agent:tool-progress",
      role: "tool",
      time: now(),
      toolCallId: info.toolCallId,
      toolName: info.toolName,
    },
    info.text,
  );
}

export function agentInputRejected(reason: string): AgentInputRejectedEvent {
  return msg(
    { type: "agent:input-rejected", role: "system", time: now() },
    reason,
  );
}

export function agentError(error: string): AgentErrorEvent {
  return msg({ type: "agent:error", role: "system", time: now() }, error);
}

// ---------------------------------------------------------------------------
// Internal agent message (loop state — NOT an event, NOT serialized)
// ---------------------------------------------------------------------------

export type AgentMessageRole =
  | "user"
  | "assistant"
  | "tool-result"
  | "extension";

export interface AssistantContent {
  type: "text" | "thinking" | "tool-call";
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

export interface AgentMessage {
  role: AgentMessageRole;
  content: string | AssistantContent[];
  timestamp: number;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  stopReason?: StopReason;
  model?: string;
  usage?: Usage;
  kind?: string;
  data?: unknown;
}

export type StopReason = "stop" | "length" | "tool-use" | "error" | "aborted";

export interface Usage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}

// ---------------------------------------------------------------------------
// AgentMessage helpers
// ---------------------------------------------------------------------------

export function nowMs(): number {
  return Date.now();
}

export function userMessage(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: nowMs() };
}

export function extensionMessage(kind: string, data: unknown): AgentMessage {
  return { role: "extension", content: "", timestamp: nowMs(), kind, data };
}

export function isLlmMessage(msg: AgentMessage): boolean {
  return msg.role !== "extension";
}
