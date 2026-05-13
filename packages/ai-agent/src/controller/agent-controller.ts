import type { ProviderV3 } from "@ai-sdk/provider";
import { generateText, stepCountIs, streamText } from "ai";
import type { CompactOptions, ContextCompactor } from "../context/context-compactor.js";
import { type SelectionStrategy, selectAll } from "../context/select-messages.js";
import { Inbox, type InboxMessage } from "../state/inbox.js";
import type { LogMessage, TurnFinishKind } from "../state/log-message.js";
import { createAgentNodeFactory } from "../state/node-factory.js";
import { NodeType } from "../state/node-types.js";
import type { Session } from "../state/session.js";
import { SkillsModel } from "../state/skills-model.js";
import { ToolRegistry } from "../state/tool-registry.js";
import type { Turn } from "../state/turn.js";
import { createListSkillsTool } from "../tools/list-skills-tool.js";
import { createListToolsTool } from "../tools/list-tools-tool.js";
import { createUseSkillsTool } from "../tools/use-skills-tool.js";

const SKILLS_INSTRUCTION = `## Skills
You have access to specialized skills. Use the \`use_skills\` tool to search
and activate skills relevant to the current task. Once activated, skills
persist across turns until you reset them.
- Search: use_skills({ prompt: "describe the problem" })`;

export const DEFAULT_SYSTEM_PROMPT = `You are a helpful assistant.

## Tool Usage
Use tools when their descriptions match the current goal. When a request is ambiguous, pick the most likely interpretation and act. If results are empty, try an alternative approach before giving up.

## Response Format
Provide concise, actionable answers.`;

export const DEFAULT_MAX_STEPS = 10;

export interface AgentControllerConfig {
  provider: ProviderV3;
  model: string;
  session?: Session;
  inbox?: Inbox;
  tools?: ToolRegistry;
  skills?: SkillsModel;
  systemPrompt?: string;
  maxSteps?: number;
  /** Cap per-step model output length. Omit to use provider default. */
  maxOutputTokens?: number;
  select?: SelectionStrategy;
  /**
   * Optional hierarchical context compactor. When set, `compact(...)` runs
   * before each `streamText` call on the session, using `compactOptions`.
   * `context-thrash` events produced by the compactor are propagated into
   * the controller's LogMessage stream.
   */
  compactor?: ContextCompactor;
  compactOptions?: Omit<CompactOptions, "eventSink">;
}

/**
 * Manages the main agent cycle: consumes messages from the Inbox,
 * runs LLM turns via Vercel AI SDK, and updates the Session tree.
 *
 * Invariant: one inbox message produces exactly one Turn node.
 * `streamText` is responsible for multi-step tool-call continuation via
 * `stopWhen: stepCountIs(maxSteps)`.
 */
export class AgentController {
  readonly session: Session;
  readonly inbox: Inbox;
  readonly tools: ToolRegistry;
  readonly skills: SkillsModel;
  provider: ProviderV3;
  model: string;
  systemPrompt: string;
  maxSteps: number;
  maxOutputTokens?: number;
  select: SelectionStrategy;
  compactor?: ContextCompactor;
  compactOptions?: Omit<CompactOptions, "eventSink">;

  /** The Turn currently being streamed. Set by run(); read by helpers. */
  #currentTurn: Turn | null = null;
  #builtinToolsRegistered = false;

  constructor(config: AgentControllerConfig) {
    this.provider = config.provider;
    this.model = config.model;
    this.systemPrompt = config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.maxSteps = config.maxSteps ?? DEFAULT_MAX_STEPS;
    this.maxOutputTokens = config.maxOutputTokens;
    this.select = config.select ?? selectAll;
    this.compactor = config.compactor;
    this.compactOptions = config.compactOptions;

    this.inbox = config.inbox ?? new Inbox();
    this.tools = config.tools ?? new ToolRegistry();
    this.skills = config.skills ?? new SkillsModel();

    if (config.session) {
      this.session = config.session;
    } else {
      const factory = createAgentNodeFactory();
      this.session = factory<Session>({ type: NodeType.session });
    }
  }

  /** Register built-in tools (list_tools, list_skills, use_skills). */
  private ensureBuiltinTools(): void {
    if (this.#builtinToolsRegistered) return;
    this.#builtinToolsRegistered = true;

    this.tools.register("list_tools", createListToolsTool(this.tools));

    if (this.skills.size > 0) {
      this.tools.register("list_skills", createListSkillsTool(this.skills));
      this.tools.register(
        "use_skills",
        createUseSkillsTool({
          skills: this.skills,
          provider: this.provider,
          model: this.model,
        }),
      );
    }
  }

  /**
   * Main agent cycle — runs until signal aborts or inbox is closed.
   *
   * Each iteration opens a new Turn up-front so all downstream operations
   * (skill selection, streamText, error handling) persist into a single
   * tree node.
   *
   * Signal is needed to unblock `inbox.take()` (raw await, not an iterator)
   * and to cancel in-flight HTTP requests in `streamText`.
   */
  async *run(signal?: AbortSignal): AsyncGenerator<LogMessage> {
    this.ensureBuiltinTools();
    for (;;) {
      const message = await this.inbox.take(signal);
      if (!message) break;

      const isFirstTurn = this.session.turns.length === 0;
      const turn = this.session.addTurn();
      this.#currentTurn = turn;
      this.session.startStreaming();

      try {
        turn.addUserMessage(message.text);

        if (isFirstTurn && this.skills.available.length > 0) {
          yield* this.selectSkillsForFirstTurn(message, signal);
        }

        // Forward stream-turn events but hold `turn-finish` until after we
        // generate the session title (when applicable), so consumers that
        // persist the session on `turn-finish` capture the title.
        let pendingFinish: LogMessage | undefined;
        for await (const ev of this.streamTurn(signal)) {
          if (ev.type === "turn-finish") {
            pendingFinish = ev;
            continue;
          }
          yield ev;
        }

        if (isFirstTurn && !this.session.title) {
          this.session.title = await this.generateTitle(message.text, signal);
        }

        if (pendingFinish) yield pendingFinish;

        this.session.stopStreaming();
      } catch (e) {
        // Safety net — individual helpers already persist their own errors.
        // Anything that escapes to here is logged and the cycle continues.
        const msg = turn.recordError(e);
        yield { type: "error", turnId: turn.id, message: msg };
        this.session.stopStreaming(e);
      } finally {
        this.#currentTurn = null;
      }
    }
  }

  /**
   * Run one streamText invocation against the current Turn.
   * streamText internally loops over tool-call steps until `stopWhen` fires.
   */
  private async *streamTurn(signal?: AbortSignal): AsyncGenerator<LogMessage> {
    const turn = this.#requireTurn();
    let sawContent = false;
    try {
      // Run hierarchical compaction before projection, if configured.
      if (this.compactor && this.compactOptions) {
        const thrashEvents: LogMessage[] = [];
        await this.compactor.compact(this.session, {
          ...this.compactOptions,
          eventSink: (e) => thrashEvents.push(e),
        });
        for (const e of thrashEvents) yield e;
      }
      const messages = await this.select(this.session);
      const result = streamText({
        model: this.provider.languageModel(this.model),
        system: this.buildSystemPrompt(),
        messages,
        tools: this.tools.toToolSet(),
        stopWhen: stepCountIs(this.maxSteps),
        abortSignal: signal,
        ...(this.maxOutputTokens !== undefined && {
          maxOutputTokens: this.maxOutputTokens,
        }),
      });

      for await (const log of this.processStream(turn, result.fullStream)) {
        if (isContentLog(log)) sawContent = true;
        yield log;
      }

      turn.model = this.model;
    } catch (e) {
      if (isAbortError(e, signal)) {
        yield this.finishTurn(turn, "aborted", "aborted");
        return;
      }
      const msg = turn.recordError(e);
      yield { type: "error", turnId: turn.id, message: msg };
      yield this.finishTurn(turn, "error", turn.stopReason ?? "error");
      return;
    }

    const reason = turn.stopReason ?? "";
    const kind = classifyFinish(reason, sawContent);
    yield this.finishTurn(turn, kind, reason || kind);
  }

  /**
   * Automatic skill selection on first turn.
   * Results and errors are persisted on the current Turn.
   */
  private async *selectSkillsForFirstTurn(
    message: InboxMessage,
    signal?: AbortSignal,
  ): AsyncGenerator<LogMessage> {
    const turn = this.#requireTurn();
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

  buildSystemPrompt(): string {
    let prompt = this.systemPrompt;

    if (this.skills.available.length > 0) {
      prompt += `\n\n${SKILLS_INSTRUCTION}`;
    }

    const selected = this.skills.selected;
    if (selected.length > 0) {
      const blocks = selected.map((s) => `### ${s.name}\n${s.content}`).join("\n\n");
      prompt += `\n\n## Active Skills\n${blocks}`;
    }

    return prompt;
  }

  /**
   * Generate a short title for the session based on the user's first message.
   * Runs a lightweight LLM call; swallows errors silently.
   */
  private async generateTitle(userText: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      const { text } = await generateText({
        model: this.provider.languageModel(this.model),
        system:
          "Generate a short title (max 6 words) for a conversation that starts with the following user message. Reply with the title only, no quotes or punctuation at the end.",
        messages: [{ role: "user", content: userText }],
        abortSignal: signal,
      });
      return text.trim();
    } catch {
      // Title generation is best-effort — do not propagate errors.
      return undefined;
    }
  }

  /** Route stream parts to Turn handlers, yield log messages as they arrive. */
  private async *processStream(
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

  #requireTurn(): Turn {
    const turn = this.#currentTurn;
    if (!turn) {
      throw new Error("AgentController: no current Turn — helper called outside run()");
    }
    return turn;
  }

  private finishTurn(turn: Turn, kind: TurnFinishKind, finishReason: string): LogMessage {
    if (!turn.stopReason) turn.stop(finishReason);
    return { type: "turn-finish", turnId: turn.id, finishReason, kind };
  }
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
