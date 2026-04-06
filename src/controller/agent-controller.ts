import type { ProviderV3 } from "@ai-sdk/provider";
import { stepCountIs, streamText } from "ai";
import {
  type SelectionStrategy,
  selectAll,
} from "../context/select-messages.js";
import { Inbox, type InboxMessage } from "../state/inbox.js";
import type { LogMessage } from "../state/log-message.js";
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
  select?: SelectionStrategy;
}

/**
 * Manages the main agent cycle: consumes messages from the Inbox,
 * runs LLM turns via Vercel AI SDK, and updates the Session tree.
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
  select: SelectionStrategy;

  constructor(config: AgentControllerConfig) {
    this.provider = config.provider;
    this.model = config.model;
    this.systemPrompt = config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.maxSteps = config.maxSteps ?? DEFAULT_MAX_STEPS;
    this.select = config.select ?? selectAll;

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

  #builtinToolsRegistered = false;

  /**
   * Main agent cycle — runs until signal aborts or inbox is closed.
   *
   * Signal is needed to unblock `inbox.take()` (raw await, not an iterator)
   * and to cancel in-flight HTTP requests in `streamText`.
   * The caller can also break the generator to stop between yields.
   */
  async *run(signal?: AbortSignal): AsyncGenerator<LogMessage> {
    this.ensureBuiltinTools();
    for (;;) {
      // Signal needed here: inbox.take() blocks on a raw await
      const message = await this.inbox.take(signal);
      if (!message) break;

      if (this.session.turns.length === 0 && this.skills.available.length > 0) {
        yield* this.selectSkillsForFirstTurn(message, signal);
      }

      let reason = yield* this.streamTurn(message.text, signal);

      // Continue if no definitive stop reason: "tool-calls" needs another
      // round, "" means error/incomplete stream — worth retrying.
      // Only "stop", "length", etc. are terminal.
      let remaining = this.maxSteps;
      while ((!reason || reason === "tool-calls") && remaining > 0) {
        remaining--;
        reason = yield* this.streamTurn("", signal);
      }
    }
  }

  /**
   * Run a single streamText cycle as a session turn.
   * Returns the finish reason from the final step.
   */
  private async *streamTurn(
    text: string,
    signal?: AbortSignal,
  ): AsyncGenerator<LogMessage, string> {
    this.session.startStreaming();
    const turn = this.session.addTurn();
    if (text) {
      turn.addUserMessage(text);
    }

    try {
      const messages = await this.select(this.session);

      // Signal needed here: cancels HTTP request and tool executions
      const result = streamText({
        model: this.provider.languageModel(this.model),
        system: this.buildSystemPrompt(),
        messages,
        tools: this.tools.toToolSet(),
        stopWhen: stepCountIs(this.maxSteps),
        abortSignal: signal,
      });

      yield* this.processStream(turn, result.fullStream);

      turn.model = this.model;
      this.session.stopStreaming();
      return turn.stopReason ?? "";
    } catch (e) {
      yield {
        type: "error",
        turnId: turn.id,
        message: e instanceof Error ? e.message : String(e),
      };
      this.session.stopStreaming(e);
      return "";
    }
  }

  /**
   * Automatic skill selection on first turn.
   * Runs silently without creating a session turn.
   */
  private async *selectSkillsForFirstTurn(
    message: InboxMessage,
    signal?: AbortSignal,
  ): AsyncGenerator<LogMessage> {
    try {
      const useSkillsTool = createUseSkillsTool({
        skills: this.skills,
        provider: this.provider,
        model: this.model,
      });
      // Signal needed here: cancels the LLM call (raw await)
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
            turnId: "",
            finishReason: `skills: ${selected.join(", ")}`,
          };
        }
      }
    } catch (e) {
      yield {
        type: "error",
        turnId: "",
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }

  buildSystemPrompt(): string {
    let prompt = this.systemPrompt;

    if (this.skills.available.length > 0) {
      prompt += `\n\n${SKILLS_INSTRUCTION}`;
    }

    const selected = this.skills.selected;
    if (selected.length > 0) {
      const blocks = selected
        .map((s) => `### ${s.name}\n${s.content}`)
        .join("\n\n");
      prompt += `\n\n## Active Skills\n${blocks}`;
    }

    return prompt;
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
}
