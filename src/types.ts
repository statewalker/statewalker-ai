import type { LlmApi } from "@statewalker/ai";
import type { LlmMessage } from "@statewalker/ai/messages";
import type { Session } from "./wrappers/session.js";

// ---------------------------------------------------------------------------
// Tool types
// ---------------------------------------------------------------------------

export interface ToolContext {
  toolCallId: string;
  toolName: string;
  signal: AbortSignal;
  onUpdate?: (partial: ToolOutput) => void;
  onProgress?: (text: string) => void;
}

export interface ToolOutput {
  text: string;
  isError?: boolean;
  details?: unknown;
}

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

export interface AgentTool {
  name: string;
  label: string;
  description: string;
  parametersSchema: Record<string, unknown>;
  sdkInputSchema?: unknown;
  execute(params: unknown, ctx: ToolContext): Promise<ToolOutput>;
}

// ---------------------------------------------------------------------------
// Selection strategy
// ---------------------------------------------------------------------------

/**
 * Walks the session tree and yields LlmMessages for the prompt.
 * The loop accumulates yielded messages and sends them to the LLM.
 * Async generator allows lazy loading of externalized nodes.
 */
export type SelectionStrategy = (
  session: Session,
) => AsyncGenerator<LlmMessage>;

// ---------------------------------------------------------------------------
// Agent loop config
// ---------------------------------------------------------------------------

export interface AgentLoopConfig {
  session: Session;
  llm: LlmApi;
  model: string;
  systemPrompt: string;
  tools: AgentTool[];
  select?: SelectionStrategy;
  signal?: AbortSignal;
}
