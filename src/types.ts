import type { FsmProcessDump } from "@statewalker/fsm";
import type { z } from "zod";

// ── Tool Interface ─────────────────────────────────────────

export interface AgentTool {
  name: string;
  description: string;
  parameters: z.ZodType;
  execute: (params: unknown, context: ToolContext) => Promise<string> | string;
}

export interface ToolContext {
  toolCallId: string;
  signal: AbortSignal;
}

// ── Messages ───────────────────────────────────────────────

export type AgentRole = "user" | "assistant" | "tool";

export interface ToolCallInfo {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface ToolResultInfo {
  toolCallId: string;
  toolName: string;
  output: string;
  isError?: boolean;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface AgentMessage {
  role: AgentRole;
  content: string;
  toolCalls?: ToolCallInfo[];
  toolResults?: ToolResultInfo[];
  usage?: TokenUsage;
  timestamp: number;
}

// ── Events (yielded by the agent loop) ─────────────────────

export type AgentEventType =
  | "text-delta"
  | "tool-call"
  | "tool-result"
  | "turn-start"
  | "turn-end"
  | "error"
  | "done";

export interface AgentEvent {
  type: AgentEventType;
  text?: string;
  toolCall?: ToolCallInfo;
  toolResult?: ToolResultInfo;
  usage?: TokenUsage;
  error?: string;
  turn?: number;
  finishReason?: string;
}

// ── Skills ─────────────────────────────────────────────────

export interface Skill {
  name: string;
  description: string;
  content: string;
}

// ── Configuration ──────────────────────────────────────────

export interface AgentConfig {
  model: Parameters<typeof import("ai").streamText>[0]["model"];
  system?: string;
  tools?: AgentTool[];
  skills?: Skill[];
  maxTurns?: number;
  maxTokens?: number;
  maskAfterTurns?: number;
}

// ── Dump / Restore ─────────────────────────────────────────

export interface AgentDump {
  messages: AgentMessage[];
  fsmDump: FsmProcessDump;
  turn: number;
  totalTokens: number;
}
