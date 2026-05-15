import type { ProviderV3 } from "@ai-sdk/provider";
import { stepCountIs, streamText } from "ai";
import type { ContextWindow } from "../context/context-window.js";
import type { InboxMessage } from "../state/inbox.js";
import type { LogMessage, TurnFinishKind } from "../state/log-message.js";
import type { SessionState } from "../state/session-state.js";
import type { SkillsModel } from "../state/skills-model.js";
import type { ToolRegistry } from "../state/tool-registry.js";
import type { Turn } from "../state/turn.js";
import { createUseSkillsTool } from "../tools/use-skills-tool.js";

export const DEFAULT_MAX_STEPS = 10;

export interface TurnDriverOptions {
  provider: ProviderV3;
  model: string;
  contextWindow: ContextWindow;
  tools: ToolRegistry;
  skills: SkillsModel;
  maxSteps?: number;
  /** Cap per-step model output length. Omit to use provider default. */
  maxOutputTokens?: number;
}

/**
 * Advances a {@link SessionState} tree by exactly one {@link Turn} per
 * `drive()` call. Owns the per-turn lifecycle: open Turn, optional
 * first-turn skill selection, `ContextWindow.build()`, `streamText()`,
 * stream-part routing, finish classification, error recording, close Turn.
 *
 * Stateless across calls — the `state` argument is the only per-call
 * mutable input. The driver instance holds only its dependencies, which
 * are session-scoped and configured by `runtime/Session` at construction.
 */
export class TurnDriver {
  readonly provider: ProviderV3;
  readonly model: string;
  readonly contextWindow: ContextWindow;
  readonly tools: ToolRegistry;
  readonly skills: SkillsModel;
  readonly maxSteps: number;
  readonly maxOutputTokens?: number;

  constructor(options: TurnDriverOptions) {
    this.provider = options.provider;
    this.model = options.model;
    this.contextWindow = options.contextWindow;
    this.tools = options.tools;
    this.skills = options.skills;
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.maxOutputTokens = options.maxOutputTokens;
  }

  /**
   * Append one new Turn to `state`, run skill selection (first turn only),
   * build the context window, stream the model call, route stream parts to
   * the Turn, and yield a final `turn-finish` event. Errors and aborts are
   * captured on the Turn and surfaced as `error` / `turn-finish` events.
   *
   * Invariant: exactly one Turn is appended to `state` per call.
   */
  async *drive(
    state: SessionState,
    message: InboxMessage,
    signal?: AbortSignal,
  ): AsyncGenerator<LogMessage> {
    const isFirstTurn = state.turns.length === 0;
    const turn = state.addTurn();
    state.startStreaming();

    let error: unknown;
    let sawContent = false;
    try {
      turn.addUserMessage(message.text);

      if (isFirstTurn && this.skills.available.length > 0) {
        yield* this.selectSkillsForFirstTurn(turn, message, signal);
      }

      const ctx = await this.contextWindow.build(state, { skills: this.skills });
      for (const e of ctx.events) yield e;

      const result = streamText({
        model: this.provider.languageModel(this.model),
        system: ctx.system,
        messages: ctx.messages,
        tools: this.tools.toToolSet(),
        stopWhen: stepCountIs(this.maxSteps),
        abortSignal: signal,
        ...(this.maxOutputTokens !== undefined && {
          maxOutputTokens: this.maxOutputTokens,
        }),
      });

      for await (const log of processStream(turn, result.fullStream)) {
        if (isContentLog(log)) sawContent = true;
        yield log;
      }

      turn.model = this.model;

      const reason = turn.stopReason ?? "";
      const kind = classifyFinish(reason, sawContent);
      yield finishTurn(turn, kind, reason || kind);
    } catch (e) {
      error = e;
      if (isAbortError(e, signal)) {
        yield finishTurn(turn, "aborted", "aborted");
      } else {
        const msg = turn.recordError(e);
        yield { type: "error", turnId: turn.id, message: msg };
        yield finishTurn(turn, "error", turn.stopReason ?? "error");
      }
    } finally {
      state.stopStreaming(error);
    }
  }

  /**
   * Best-effort first-turn skill selection. Invokes the `use_skills` tool
   * against the inbox message text; on success emits a single `step-finish`
   * LogMessage listing the selected skills; on failure logs to console and
   * continues — never aborts the turn.
   */
  private async *selectSkillsForFirstTurn(
    turn: Turn,
    message: InboxMessage,
    signal?: AbortSignal,
  ): AsyncGenerator<LogMessage> {
    try {
      const useSkillsTool = createUseSkillsTool({
        skills: this.skills,
        provider: this.provider,
        model: this.model,
      });
      const result = await useSkillsTool.execute?.(
        { prompt: message.text },
        {
          toolCallId: `skill-select-${Date.now()}`,
          messages: [],
          abortSignal: signal,
        },
      );

      if (result && typeof result === "object" && "selected" in result) {
        const selected = (result as { selected: string[] }).selected;
        if (selected.length > 0) {
          yield {
            type: "step-finish",
            turnId: turn.id,
            finishReason: `skills: ${selected.join(", ")}`,
          };
        }
      }
    } catch (e) {
      if (isAbortError(e, signal)) throw e;
      // Skill selection is a best-effort optimization. Many local
      // models can't produce valid structured output reliably (no
      // grammar-constrained generation in transformers.js, smaller
      // WebLLM models also struggle), and the conversation continues
      // perfectly fine without any skills selected — the agent has
      // access to all skills via the `use_skills` tool regardless.
      // Treating this as a turn-level error surfaced a red banner in
      // the chat for what is purely a heuristic miss; demote to a
      // console warning instead.
      console.warn("[agent] skill selection failed; continuing without preselected skills", e);
    }
  }
}

// ── Helpers (module-private) ─────────────────────────────────────────────

/** Route stream parts to Turn handlers, yield log messages as they arrive. */
async function* processStream(
  turn: Turn,
  stream: AsyncIterable<{ type: string; [key: string]: unknown }>,
): AsyncGenerator<LogMessage> {
  for await (const part of stream) {
    const type = part.type;
    let log: LogMessage | undefined;

    if (type.startsWith("text-")) {
      log = turn.handleText(part);
    } else if (type.startsWith("reasoning-")) {
      log = turn.handleReasoning(part);
    } else if (type.startsWith("tool-input-")) {
      log = turn.handleToolInput(part);
    } else if (type.startsWith("tool-")) {
      log = turn.handleTool(part);
    } else if (type === "finish-step") {
      log = turn.handleFinishStep(part);
    } else if (type === "finish") {
      turn.handleFinish(part);
    } else if (type === "error") {
      log = turn.handleError(part);
    } else if (type === "source" || type === "file") {
      turn.handleMetadata(part);
    }
    // start, start-step, finish, raw — no side effects

    if (log) yield log;
  }
}

function finishTurn(turn: Turn, kind: TurnFinishKind, finishReason: string): LogMessage {
  if (!turn.stopReason) turn.stop(finishReason);
  return { type: "turn-finish", turnId: turn.id, finishReason, kind };
}

/** Classify the SDK finishReason into a stable kind the caller can switch on. */
function classifyFinish(reason: string, sawContent: boolean): TurnFinishKind {
  switch (reason) {
    case "stop":
      return sawContent ? "ok" : "empty";
    case "tool-calls":
      // Reached the end of a streamText run with tool-calls still pending:
      // streamText only returns this when stopWhen cut us off.
      return "step-limit";
    case "length":
      return "length";
    case "content-filter":
      return "filtered";
    case "error":
      return "error";
    case "":
      // No finish-step arrived — stream ended without the SDK announcing a
      // reason. Treat as empty so consumers see a clean terminal event.
      return "empty";
    default:
      return "unknown";
  }
}

function isContentLog(log: LogMessage): boolean {
  return (
    log.type === "text-delta" ||
    log.type === "reasoning" ||
    log.type === "tool-call" ||
    log.type === "tool-result"
  );
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (error instanceof Error) {
    return error.name === "AbortError" || error.name === "AbortSignalError";
  }
  return false;
}
