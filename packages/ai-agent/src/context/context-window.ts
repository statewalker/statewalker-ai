import type { ProviderV3 } from "@ai-sdk/provider";
import type { ModelMessage } from "ai";
import type { LogMessage } from "../state/log-message.js";
import type { Session } from "../state/session.js";
import type { SkillsModel } from "../state/skills-model.js";
import { type CompactOptions, ContextCompactor } from "./context-compactor.js";
import type { HierarchicalSummarizer } from "./hierarchical-summarizer.js";
import { createPinPolicy, type PinPolicy } from "./pin-policy.js";
import { type SelectionStrategy, selectAll } from "./select-messages.js";
import { createTokenEstimator, type TokenEstimator } from "./token-estimator.js";
import { createDefaultElisionPolicy, type ToolElisionPolicy } from "./tool-elision.js";

/**
 * Skills instruction block injected into the system prompt when the active
 * session exposes at least one skill via `SkillsModel.available`.
 */
export const SKILLS_INSTRUCTION = `## Skills
You have access to specialized skills. Use the \`use_skills\` tool to search
and activate skills relevant to the current task. Once activated, skills
persist across turns until you reset them.
- Search: use_skills({ prompt: "describe the problem" })`;

/**
 * Default base template the runtime uses when no per-agent `systemPrompt`
 * override is configured. Kept here so `AgentController` and `ContextWindow`
 * agree on the same default.
 */
export const DEFAULT_SYSTEM_PROMPT = `You are a helpful assistant.

## Tool Usage
Use tools when their descriptions match the current goal. When a request is ambiguous, pick the most likely interpretation and act. If results are empty, try an alternative approach before giving up.

## Response Format
Provide concise, actionable answers.`;

/** Construction options for a per-Session {@link ContextWindow}. */
export interface ContextWindowOptions {
  /** Required only for downstream callers (not used internally today). */
  provider: ProviderV3;
  /** Model id (used by callers via `provider.languageModel(model)` — not by build). */
  model: string;
  /** Selection strategy. Defaults to {@link selectAll}. */
  selectStrategy?: SelectionStrategy;
  /**
   * Base system-prompt template. Defaults to {@link DEFAULT_SYSTEM_PROMPT}.
   * Per-agent overrides should be threaded in by the runtime at construction.
   */
  systemPromptTemplate?: string;
  /** Token estimator. Defaults to {@link createTokenEstimator}. */
  estimator?: TokenEstimator;
  /** Pin policy. Defaults to a no-pin policy. */
  pinPolicy?: PinPolicy;
  /** Tool-result elision policy. Defaults to {@link createDefaultElisionPolicy}. */
  elisionPolicy?: ToolElisionPolicy;
  /** Hierarchical summariser. Required to enable budget compaction. */
  summarizer?: HierarchicalSummarizer;
  /** Token budget for hierarchical compaction. */
  budgetTokens?: number;
  /** Compaction tunables — pass-through to {@link ContextCompactor}. */
  keepRecentTurns?: number;
  groupSize?: number;
  depthPromoteThreshold?: number;
  maxPassesPerCompact?: number;
}

/** Snapshot returned by {@link ContextWindow.build}. */
export interface ContextWindowResult {
  /** System prompt for the upcoming `streamText` call. */
  system: string;
  /** Projected `ModelMessage[]` to send to the model. */
  messages: ModelMessage[];
  /**
   * Events produced during this `build()` (e.g. `context-thrash`).
   * The caller forwards these into its log stream.
   */
  events: LogMessage[];
  stats: {
    messageCount: number;
    estimatedTokens: number;
    compacted: boolean;
  };
}

/**
 * Owns context shaping for one model call.
 *
 * One {@link ContextWindow} is constructed per `Session` and reused across
 * every turn. `build(state, { skills })` runs compaction (mutating the
 * tree when configured), selection (projecting to `ModelMessage[]`), and
 * system-prompt assembly. Replaces the previous integration that lived
 * inline in `AgentController.streamTurn()` and `buildSystemPrompt()`.
 *
 * Tree mutation is part of the contract: when budget compaction is
 * configured, `build()` adopts older turns under `TurnGroup` wrappers, and
 * those wrappers persist into the saved session. Callers MUST NOT invoke
 * `build()` concurrently against the same `state` — the agent loop is
 * serial per session and this invariant is the caller's responsibility.
 */
export class ContextWindow {
  readonly provider: ProviderV3;
  readonly model: string;
  private readonly selectStrategy: SelectionStrategy;
  private readonly systemPromptTemplate: string;
  private readonly estimator: TokenEstimator;
  private readonly pinPolicy: PinPolicy;
  private readonly elisionPolicy: ToolElisionPolicy;
  private readonly summarizer?: HierarchicalSummarizer;
  private readonly budgetTokens?: number;
  private readonly keepRecentTurns?: number;
  private readonly groupSize?: number;
  private readonly depthPromoteThreshold?: number;
  private readonly maxPassesPerCompact?: number;
  private readonly compactor: ContextCompactor;

  constructor(options: ContextWindowOptions) {
    this.provider = options.provider;
    this.model = options.model;
    this.selectStrategy = options.selectStrategy ?? selectAll;
    this.systemPromptTemplate = options.systemPromptTemplate ?? DEFAULT_SYSTEM_PROMPT;
    this.estimator = options.estimator ?? createTokenEstimator();
    this.pinPolicy = options.pinPolicy ?? createPinPolicy({ predicates: [] });
    this.elisionPolicy = options.elisionPolicy ?? createDefaultElisionPolicy();
    this.summarizer = options.summarizer;
    this.budgetTokens = options.budgetTokens;
    this.keepRecentTurns = options.keepRecentTurns;
    this.groupSize = options.groupSize;
    this.depthPromoteThreshold = options.depthPromoteThreshold;
    this.maxPassesPerCompact = options.maxPassesPerCompact;
    this.compactor = new ContextCompactor();
  }

  /**
   * Produce one model call's inputs.
   *
   * Steps:
   * 1. Prepare the pin policy (lets it scan the session once per build).
   * 2. Run hierarchical compaction when both `budgetTokens` and `summarizer`
   *    are configured — mutates the tree, collects `context-thrash` events.
   * 3. Build the system prompt from the template + active skills.
   * 4. Run the selection strategy to project to `ModelMessage[]`.
   */
  async build(state: Session, opts: { skills: SkillsModel }): Promise<ContextWindowResult> {
    this.pinPolicy.prepare?.(state);

    const events: LogMessage[] = [];
    let compacted = false;
    if (this.budgetTokens !== undefined && this.summarizer) {
      const compactOptions: CompactOptions = {
        budgetTokens: this.budgetTokens,
        summarizer: this.summarizer,
        estimator: this.estimator,
        pinPolicy: this.pinPolicy,
        elisionPolicy: this.elisionPolicy,
        eventSink: (e) => events.push(e),
      };
      if (this.keepRecentTurns !== undefined) compactOptions.keepRecentTurns = this.keepRecentTurns;
      if (this.groupSize !== undefined) compactOptions.groupSize = this.groupSize;
      if (this.depthPromoteThreshold !== undefined)
        compactOptions.depthPromoteThreshold = this.depthPromoteThreshold;
      if (this.maxPassesPerCompact !== undefined)
        compactOptions.maxPassesPerCompact = this.maxPassesPerCompact;
      const result = await this.compactor.compact(state, compactOptions);
      compacted = result.passes > 0 || result.thrashed || result.elided || events.length > 0;
    }

    const system = this.buildSystemPrompt(opts.skills);
    const messages = await this.selectStrategy(state);
    const estimatedTokens = this.estimator.estimate(messages);

    return {
      system,
      messages,
      events,
      stats: {
        messageCount: messages.length,
        estimatedTokens,
        compacted,
      },
    };
  }

  /**
   * Identical output to the previous `AgentController.buildSystemPrompt()`:
   * template + skills instruction (when any are available) + active skill
   * blocks (when any are selected).
   */
  private buildSystemPrompt(skills: SkillsModel): string {
    let prompt = this.systemPromptTemplate;
    if (skills.available.length > 0) {
      prompt += `\n\n${SKILLS_INSTRUCTION}`;
    }
    const selected = skills.selected;
    if (selected.length > 0) {
      const blocks = selected.map((s) => `### ${s.name}\n${s.content}`).join("\n\n");
      prompt += `\n\n## Active Skills\n${blocks}`;
    }
    return prompt;
  }
}
