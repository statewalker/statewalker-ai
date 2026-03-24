/**
 * AgentTool — the primary extension point for custom tools.
 *
 * Inspired by yoagent's AgentTool trait. Each tool declares its name,
 * description, JSON Schema parameters, and an async execute function.
 *
 * Tools are independent of the LLM provider — the agent loop translates
 * them to the provider's tool format automatically.
 */

// ---------------------------------------------------------------------------
// Tool context (per-invocation state)
// ---------------------------------------------------------------------------

export interface ToolContext {
  toolCallId: string;
  toolName: string;
  signal: AbortSignal;
  /** Emit streaming partial results (UI/logging only, not sent to LLM). */
  onUpdate?: (partial: ToolOutput) => void;
  /** Emit user-facing progress text. */
  onProgress?: (text: string) => void;
}

// ---------------------------------------------------------------------------
// Tool output
// ---------------------------------------------------------------------------

export interface ToolOutput {
  text: string;
  isError?: boolean;
  details?: unknown;
}

// ---------------------------------------------------------------------------
// Tool error
// ---------------------------------------------------------------------------

export class ToolError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "failed"
      | "not-found"
      | "invalid-args"
      | "cancelled" = "failed",
  ) {
    super(message);
    this.name = "ToolError";
  }
}

// ---------------------------------------------------------------------------
// AgentTool interface
// ---------------------------------------------------------------------------

export interface AgentTool {
  /** Unique tool name (used in LLM tool_use). */
  name: string;
  /** Human-readable label for UI. */
  label: string;
  /** Description for the LLM. */
  description: string;
  /** JSON Schema for parameters. */
  parametersSchema: Record<string, unknown>;
  /** Execute the tool with the given parameters. */
  execute(params: unknown, ctx: ToolContext): Promise<ToolOutput>;
}

// ---------------------------------------------------------------------------
// Tool execution strategy
// ---------------------------------------------------------------------------

export type ToolExecutionStrategy =
  | { type: "parallel" }
  | { type: "sequential" }
  | { type: "batched"; size: number };

export const defaultToolStrategy: ToolExecutionStrategy = { type: "parallel" };
