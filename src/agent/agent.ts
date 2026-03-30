/**
 * Stateful Agent — wraps the agent loop with state management,
 * steering/follow-up queues, and abort support.
 *
 * Usage:
 *   const agent = new Agent(llm)
 *     .withSystemPrompt("You are a helpful assistant.")
 *     .withModel("claude-sonnet-4-20250514")
 *     .withTools([myTool]);
 *
 *   for await (const event of agent.prompt("Hello!")) {
 *     // handle event
 *   }
 *   // breaking out cancels in-flight LLM/tool operations
 */
import type { LlmApi } from "@statewalker/ai";
import type {
  CompactionStrategy,
  ContextConfig,
  ExecutionLimits,
} from "../context/context-manager.js";
import {
  defaultContextConfig,
  defaultExecutionLimits,
} from "../context/context-manager.js";
import type {
  AgentEvent,
  AgentMessage,
  Usage,
} from "../events/agent-events.js";
import { userMessage } from "../events/agent-events.js";
import type { SkillInfo, SkillSet } from "../skills/skill-types.js";
import type { AgentTool, ToolExecutionStrategy } from "../tools/agent-tool.js";
import type { AgentContext, InputFilter } from "./agent-loop.js";
import { agentLoop, agentLoopContinue } from "./agent-loop.js";
import { structuredAgentLoop } from "./structured-loop.js";

export class Agent {
  systemPrompt = "";
  model = "";
  private llm: LlmApi;
  private messages: AgentMessage[] = [];
  private tools: AgentTool[] = [];
  private toolExecution: ToolExecutionStrategy = { type: "parallel" };
  private contextConfig: ContextConfig | undefined = {
    ...defaultContextConfig,
  };
  private compactionStrategy: CompactionStrategy | undefined;
  private executionLimits: ExecutionLimits | undefined = {
    ...defaultExecutionLimits,
  };
  private maxSteps = 1;
  private loopType: "standard" | "structured" = "structured";
  private maxIterations = 3;
  private planningPrompt?: string;
  private validationPrompt?: string;
  private skillInfos: SkillInfo[] = [];

  // Queues
  private steeringQueue: AgentMessage[] = [];
  private followUpQueue: AgentMessage[] = [];

  // Callbacks
  private beforeTurnFn?: (messages: AgentMessage[], turn: number) => boolean;
  private afterTurnFn?: (messages: AgentMessage[], usage: Usage) => void;
  private onErrorFn?: (error: string) => void;
  private inputFilters: InputFilter[] = [];

  // Control
  private running = false;

  constructor(llm: LlmApi) {
    this.llm = llm;
  }

  // -- Builder methods --

  withSystemPrompt(prompt: string): this {
    this.systemPrompt = prompt;
    return this;
  }

  withModel(model: string): this {
    this.model = model;
    return this;
  }

  withTools(tools: AgentTool[]): this {
    this.tools = tools;
    return this;
  }

  withToolExecution(strategy: ToolExecutionStrategy): this {
    this.toolExecution = strategy;
    return this;
  }

  withContextConfig(config: ContextConfig): this {
    this.contextConfig = config;
    return this;
  }

  withCompactionStrategy(strategy: CompactionStrategy): this {
    this.compactionStrategy = strategy;
    return this;
  }

  withExecutionLimits(limits: ExecutionLimits): this {
    this.executionLimits = limits;
    return this;
  }

  withMaxSteps(steps: number): this {
    this.maxSteps = steps;
    return this;
  }

  withSkills(skills: SkillSet): this {
    // Store raw skill infos for the structured loop's skill-selection phase
    this.skillInfos = skills.skills;
    // For the standard loop, append the skill index to the system prompt
    const fragment = skills.formatForPrompt();
    if (fragment) {
      this.systemPrompt = this.systemPrompt
        ? `${this.systemPrompt}\n\n${fragment}`
        : fragment;
    }
    return this;
  }

  withMessages(msgs: AgentMessage[]): this {
    this.messages = msgs;
    return this;
  }

  withInputFilter(filter: InputFilter): this {
    this.inputFilters.push(filter);
    return this;
  }

  onBeforeTurn(fn: (messages: AgentMessage[], turn: number) => boolean): this {
    this.beforeTurnFn = fn;
    return this;
  }

  onAfterTurn(fn: (messages: AgentMessage[], usage: Usage) => void): this {
    this.afterTurnFn = fn;
    return this;
  }

  onError(fn: (error: string) => void): this {
    this.onErrorFn = fn;
    return this;
  }

  withoutContextManagement(): this {
    this.contextConfig = undefined;
    this.executionLimits = undefined;
    return this;
  }

  withLoopType(type: "standard" | "structured"): this {
    this.loopType = type;
    return this;
  }

  withMaxIterations(n: number): this {
    this.maxIterations = n;
    return this;
  }

  withPlanningPrompt(prompt: string): this {
    this.planningPrompt = prompt;
    return this;
  }

  withValidationPrompt(prompt: string): this {
    this.validationPrompt = prompt;
    return this;
  }

  // -- State access --

  getMessages(): AgentMessage[] {
    return this.messages;
  }

  isRunning(): boolean {
    return this.running;
  }

  clearMessages(): void {
    this.messages = [];
  }

  appendMessage(msg: AgentMessage): void {
    this.messages.push(msg);
  }

  replaceMessages(msgs: AgentMessage[]): void {
    this.messages = msgs;
  }

  saveMessages(): string {
    return JSON.stringify(this.messages);
  }

  restoreMessages(json: string): void {
    this.messages = JSON.parse(json) as AgentMessage[];
  }

  // -- Queue management --

  steer(msg: AgentMessage): void {
    this.steeringQueue.push(msg);
  }

  followUp(msg: AgentMessage): void {
    this.followUpQueue.push(msg);
  }

  clearQueues(): void {
    this.steeringQueue = [];
    this.followUpQueue = [];
  }

  // -- Control --

  reset(): void {
    this.messages = [];
    this.clearQueues();
    this.running = false;
  }

  // -- Prompting --

  /**
   * Send a text prompt and get an async iterable of events.
   * Breaking out of the loop cancels in-flight operations.
   */
  async *prompt(text: string): AsyncGenerator<AgentEvent> {
    yield* this.promptMessages([userMessage(text)]);
  }

  /**
   * Send messages as a prompt and get an async iterable of events.
   * Breaking out of the loop cancels in-flight operations.
   */
  async *promptMessages(prompts: AgentMessage[]): AsyncGenerator<AgentEvent> {
    if (this.running) {
      throw new Error("Agent is already running. Use steer() or followUp().");
    }

    this.running = true;
    const context: AgentContext = {
      systemPrompt: this.systemPrompt,
      messages: [...this.messages],
      tools: this.tools,
    };

    try {
      if (this.loopType === "structured") {
        yield* structuredAgentLoop(prompts, context, {
          llm: this.llm,
          model: this.model,
          systemPrompt: this.systemPrompt,
          tools: this.tools,
          skills: this.skillInfos.length > 0 ? this.skillInfos : undefined,
          maxIterations: this.maxIterations,
          planningPrompt: this.planningPrompt,
          validationPrompt: this.validationPrompt,
          executionLimits: this.executionLimits,
          onError: this.onErrorFn,
        });
      } else {
        yield* agentLoop(prompts, context, this.buildConfig());
      }
    } finally {
      this.messages = context.messages;
      this.running = false;
    }
  }

  /**
   * Continue from current context.
   * Breaking out of the loop cancels in-flight operations.
   */
  async *continueLoop(): AsyncGenerator<AgentEvent> {
    if (this.running) {
      throw new Error("Agent is already running.");
    }
    if (this.messages.length === 0) {
      throw new Error("No messages to continue from.");
    }

    this.running = true;
    const context: AgentContext = {
      systemPrompt: this.systemPrompt,
      messages: [...this.messages],
      tools: this.tools,
    };

    try {
      yield* agentLoopContinue(context, this.buildConfig());
    } finally {
      this.messages = context.messages;
      this.running = false;
    }
  }

  // -- Internal --

  private buildConfig() {
    return {
      llm: this.llm,
      model: this.model,
      systemPrompt: this.systemPrompt,
      tools: this.tools,
      toolExecution: this.toolExecution,
      contextConfig: this.contextConfig,
      compactionStrategy: this.compactionStrategy,
      executionLimits: this.executionLimits,
      maxSteps: this.maxSteps,
      getSteeringMessages: () => {
        const msgs = [...this.steeringQueue];
        this.steeringQueue = [];
        return msgs;
      },
      getFollowUpMessages: () => {
        const msgs = [...this.followUpQueue];
        this.followUpQueue = [];
        return msgs;
      },
      beforeTurn: this.beforeTurnFn,
      afterTurn: this.afterTurnFn,
      onError: this.onErrorFn,
      inputFilters: this.inputFilters,
    };
  }
}
