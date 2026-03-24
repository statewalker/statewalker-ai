/**
 * The core agent loop: prompt → LLM stream → tool execution → repeat.
 *
 * Returns an AsyncGenerator<AgentEvent> — the caller consumes events with
 * `for await`. Breaking out of the loop cancels in-flight LLM/tool operations.
 *
 * Events are structurally compatible with ContentMessage from content-blocks:
 *   { props: { time, role, type, ...extra }, blocks: [{ content }] }
 */
import type { LlmApi } from "@statewalker/ai";
import type { LlmMessage } from "@statewalker/ai/messages";
import type {
  CompactionStrategy,
  ContextConfig,
  ExecutionLimits,
} from "../context/context-manager.js";
import {
  compactMessages,
  ExecutionTracker,
  messageTokens,
} from "../context/context-manager.js";
import type {
  AgentEvent,
  AgentMessage,
  Usage,
} from "../events/agent-events.js";
import {
  agentAssistant,
  agentEnd,
  agentError,
  agentInputRejected,
  agentStart,
  agentTextDelta,
  agentThinkingDelta,
  agentToolCall,
  agentToolResult,
  agentTurnEnd,
  agentTurnStart,
  isLlmMessage,
  nowMs,
} from "../events/agent-events.js";
import type { AgentTool, ToolExecutionStrategy } from "../tools/agent-tool.js";
import { defaultToolStrategy } from "../tools/agent-tool.js";
import type { ToolCall } from "../tools/tool-executor.js";
import { executeToolCalls } from "../tools/tool-executor.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface AgentLoopConfig {
  llm: LlmApi;
  model: string;
  systemPrompt: string;
  tools: AgentTool[];
  toolExecution?: ToolExecutionStrategy;
  contextConfig?: ContextConfig;
  compactionStrategy?: CompactionStrategy;
  executionLimits?: ExecutionLimits;
  maxSteps?: number;
  /** Get steering messages (user interruptions mid-run). */
  getSteeringMessages?: () => AgentMessage[];
  /** Get follow-up messages (queued work after agent finishes). */
  getFollowUpMessages?: () => AgentMessage[];
  /** Called before each LLM turn. Return false to abort. */
  beforeTurn?: (messages: AgentMessage[], turnNumber: number) => boolean;
  /** Called after each LLM turn. */
  afterTurn?: (messages: AgentMessage[], usage: Usage) => void;
  /** Called on LLM error. */
  onError?: (error: string) => void;
  /** Input filters applied to user messages. */
  inputFilters?: InputFilter[];
}

export interface InputFilter {
  filter(text: string): FilterResult;
}

export type FilterResult =
  | { type: "pass" }
  | { type: "warn"; message: string }
  | { type: "reject"; reason: string };

// ---------------------------------------------------------------------------
// Agent context (mutable state passed through the loop)
// ---------------------------------------------------------------------------

export interface AgentContext {
  systemPrompt: string;
  messages: AgentMessage[];
  tools: AgentTool[];
}

// ---------------------------------------------------------------------------
// Agent loop entry points — AsyncGenerators
// ---------------------------------------------------------------------------

/**
 * Start an agent loop with new prompt messages.
 */
export async function* agentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
): AsyncGenerator<AgentEvent> {
  const abort = new AbortController();
  try {
    yield agentStart();

    // Apply input filters
    const filtered = applyInputFilters(prompts, config.inputFilters);
    if (!filtered) {
      yield agentInputRejected("Input rejected by filter");
      yield agentEnd();
      return;
    }

    // Add prompts to context
    for (const p of filtered) {
      context.messages.push(p);
    }

    yield* runLoop(context, config, abort.signal);
    yield agentEnd();
  } finally {
    abort.abort();
  }
}

/**
 * Continue an agent loop from existing context.
 */
export async function* agentLoopContinue(
  context: AgentContext,
  config: AgentLoopConfig,
): AsyncGenerator<AgentEvent> {
  const abort = new AbortController();
  try {
    yield agentStart();
    yield* runLoop(context, config, abort.signal);
    yield agentEnd();
  } finally {
    abort.abort();
  }
}

// ---------------------------------------------------------------------------
// Main loop logic
// ---------------------------------------------------------------------------

async function* runLoop(
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal,
): AsyncGenerator<AgentEvent> {
  let turnNumber = 0;
  const tracker = config.executionLimits
    ? new ExecutionTracker(config.executionLimits)
    : null;

  let pending = config.getSteeringMessages?.() ?? [];

  // Outer loop: follow-ups after agent would stop
  while (!signal.aborted) {
    // Inner loop: process turns
    while (!signal.aborted) {
      turnNumber++;
      yield agentTurnStart(turnNumber);

      // Inject pending messages
      for (const msg of pending) {
        context.messages.push(msg);
      }
      pending = [];

      // Check execution limits
      if (tracker) {
        const reason = tracker.checkLimits();
        if (reason) {
          const limitMsg: AgentMessage = {
            role: "user",
            content: `[Agent stopped: ${reason}]`,
            timestamp: nowMs(),
          };
          context.messages.push(limitMsg);
          yield agentError(reason);
          return;
        }
      }

      // Before-turn callback
      if (
        config.beforeTurn &&
        !config.beforeTurn(context.messages, turnNumber)
      ) {
        return;
      }

      // Compact context if configured
      if (config.contextConfig) {
        const strategy = config.compactionStrategy;
        context.messages = strategy
          ? strategy.compact(context.messages, config.contextConfig)
          : compactMessages(context.messages, config.contextConfig);
      }

      // Stream assistant response
      const assistantMsg = yield* streamAssistantResponse(
        context,
        config,
        signal,
      );
      context.messages.push(assistantMsg);

      // Check for error/abort
      if (
        assistantMsg.stopReason === "error" ||
        assistantMsg.stopReason === "aborted"
      ) {
        if (assistantMsg.stopReason === "error") {
          config.onError?.(
            typeof assistantMsg.content === "string"
              ? assistantMsg.content
              : "Unknown error",
          );
        }
        const usage = assistantMsg.usage ?? { input: 0, output: 0 };
        config.afterTurn?.(context.messages, usage);
        yield agentTurnEnd(assistantMsg.stopReason, assistantMsg.model);
        return;
      }

      // Extract tool calls and execute them via AgentTool[].
      // When context.tools is empty, tool execution is delegated to the
      // LLM provider (Vercel AI SDK handles it internally via maxSteps).
      // In that case tool-call/tool-result events were already yielded
      // from streamAssistantResponse — we just skip the execute step.
      const toolCalls = extractToolCalls(assistantMsg);
      const hasToolCalls = toolCalls.length > 0;
      const hasAgentTools = context.tools.length > 0;

      if (hasToolCalls && hasAgentTools) {
        const toolGen = executeToolCalls(
          context.tools,
          toolCalls,
          signal,
          config.toolExecution ?? defaultToolStrategy,
          config.getSteeringMessages,
        );

        // Drain the tool generator, yielding its events
        let toolNext = await toolGen.next();
        while (!toolNext.done) {
          yield toolNext.value;
          toolNext = await toolGen.next();
        }
        const execution = toolNext.value;

        for (const result of execution.toolResults) {
          context.messages.push(result);
        }

        if (execution.steeringMessages?.length) {
          pending = execution.steeringMessages;
        }
      }

      // Track turn
      if (tracker) {
        const turnTokens = assistantMsg.usage
          ? assistantMsg.usage.input + assistantMsg.usage.output
          : messageTokens(assistantMsg);
        tracker.recordTurn(turnTokens);
      }

      // After-turn callback
      const usage = assistantMsg.usage ?? { input: 0, output: 0 };
      config.afterTurn?.(context.messages, usage);

      yield agentTurnEnd(assistantMsg.stopReason, assistantMsg.model);

      // Check steering after turn
      if (pending.length === 0) {
        pending = config.getSteeringMessages?.() ?? [];
      }

      // Exit inner loop if no more tool calls (or SDK handled them) and no pending
      if ((!hasToolCalls || !hasAgentTools) && pending.length === 0) break;
    }

    // Check for follow-ups
    const followUps = config.getFollowUpMessages?.() ?? [];
    if (followUps.length > 0) {
      pending = followUps;
      continue;
    }
    break;
  }
}

// ---------------------------------------------------------------------------
// Stream assistant response (yields events, returns final message)
// ---------------------------------------------------------------------------

async function* streamAssistantResponse(
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal,
): AsyncGenerator<AgentEvent, AgentMessage> {
  // Convert to LLM messages (filter out extensions)
  const llmMessages: LlmMessage[] = context.messages
    .filter(isLlmMessage)
    .map(agentToLlmMessage);

  try {
    yield agentAssistant();

    const parts: Array<{ type: string; [key: string]: unknown }> = [];
    let finishReason = "stop";
    // Track whether we need a new assistant message after tool results
    let lastPartWasToolResult = false;

    const stream = config.llm.streamChatCompletion({
      model: config.model,
      system: context.systemPrompt,
      messages: llmMessages,
      signal,
      maxSteps: config.maxSteps ?? 15,
    });

    for await (const part of stream) {
      if (signal.aborted) break;
      parts.push(part);

      switch (part.type) {
        case "text-delta":
          // After tool results, emit a new assistant message boundary
          // so the text doesn't append to the tool message
          if (lastPartWasToolResult) {
            yield agentAssistant();
            lastPartWasToolResult = false;
          }
          yield agentTextDelta(part.textDelta);
          break;
        case "reasoning":
          if (lastPartWasToolResult) {
            yield agentAssistant();
            lastPartWasToolResult = false;
          }
          yield agentThinkingDelta(part.textDelta);
          break;
        case "tool-call":
          lastPartWasToolResult = false;
          yield agentToolCall({
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            args: part.args,
          });
          break;
        case "tool-result":
          lastPartWasToolResult = true;
          yield agentToolResult({
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            text:
              typeof part.result === "string"
                ? part.result
                : JSON.stringify(part.result),
          });
          break;
        case "step-finish":
          finishReason = part.finishReason;
          break;
      }
    }

    return buildAssistantMessage(parts, config.model, finishReason);
  } catch (err) {
    yield agentError(err instanceof Error ? err.message : String(err));
    return {
      role: "assistant",
      content: err instanceof Error ? err.message : String(err),
      timestamp: nowMs(),
      stopReason: signal.aborted ? "aborted" : "error",
      model: config.model,
      usage: { input: 0, output: 0 },
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildAssistantMessage(
  parts: Array<{ type: string; [key: string]: unknown }>,
  model: string,
  finishReason: string,
): AgentMessage {
  const textParts: string[] = [];
  const toolCalls: Array<{
    type: "tool-call";
    id: string;
    name: string;
    arguments: unknown;
  }> = [];

  for (const part of parts) {
    if (part.type === "text-delta") {
      textParts.push(String(part.textDelta ?? ""));
    } else if (part.type === "tool-call") {
      toolCalls.push({
        type: "tool-call",
        id: String(part.toolCallId),
        name: String(part.toolName),
        arguments: part.args,
      });
    }
  }

  const text = textParts.join("");
  const stopReason =
    finishReason === "tool-calls" ? ("tool-use" as const) : ("stop" as const);

  if (toolCalls.length > 0) {
    const content = [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...toolCalls.map((tc) => ({
        type: "tool-call" as const,
        text: undefined,
        thinking: undefined,
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
      })),
    ];
    return {
      role: "assistant",
      content,
      timestamp: nowMs(),
      stopReason,
      model,
      usage: { input: 0, output: 0 },
    };
  }

  return {
    role: "assistant",
    content: text,
    timestamp: nowMs(),
    stopReason,
    model,
    usage: { input: 0, output: 0 },
  };
}

function extractToolCalls(msg: AgentMessage): ToolCall[] {
  if (typeof msg.content === "string") return [];
  return msg.content
    .filter((p) => p.type === "tool-call")
    .map((p) => ({
      id: p.id ?? "",
      name: p.name ?? "",
      args: p.arguments ?? {},
    }));
}

function agentToLlmMessage(msg: AgentMessage): LlmMessage {
  if (msg.role === "user") {
    return {
      role: "user",
      content:
        typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content),
    };
  }
  if (msg.role === "assistant") {
    if (typeof msg.content === "string") {
      return { role: "assistant", content: msg.content };
    }
    return {
      role: "assistant",
      content: msg.content.map((p) => {
        if (p.type === "tool-call") {
          return {
            type: "tool-call" as const,
            toolCallId: p.id ?? "",
            toolName: p.name ?? "",
            args: (p.arguments ?? {}) as Record<string, unknown>,
          };
        }
        return { type: "text" as const, text: p.text ?? "" };
      }),
    };
  }
  if (msg.role === "tool-result") {
    return {
      role: "tool",
      content: [
        {
          type: "tool-result" as const,
          toolCallId: msg.toolCallId ?? "",
          toolName: msg.toolName ?? "",
          result: msg.content,
          isError: msg.isError,
        },
      ],
    };
  }
  return { role: "user", content: "" };
}

function applyInputFilters(
  prompts: AgentMessage[],
  filters: InputFilter[] | undefined,
): AgentMessage[] | null {
  if (!filters?.length) return prompts;

  const userText = prompts
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n");

  const warnings: string[] = [];
  for (const filter of filters) {
    const result = filter.filter(userText);
    if (result.type === "reject") {
      return null;
    }
    if (result.type === "warn") {
      warnings.push(result.message);
    }
  }

  if (warnings.length === 0) return prompts;

  const warningText = warnings.map((w) => `[Warning: ${w}]`).join("\n");
  const modified = [...prompts];
  for (let i = modified.length - 1; i >= 0; i--) {
    const current = modified[i];
    if (current?.role === "user" && typeof current.content === "string") {
      modified[i] = {
        ...current,
        content: `${current.content}\n${warningText}`,
      };
      break;
    }
  }
  return modified;
}
