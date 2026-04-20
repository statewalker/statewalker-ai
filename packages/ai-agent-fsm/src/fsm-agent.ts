import type { FsmState } from "@statewalker/fsm";
import { FsmProcess } from "@statewalker/fsm";
import { AgentContext, buildSystemPrompt } from "./context.js";
import { createAgentFsmConfig } from "./fsm-config.js";
import { generate } from "./generate.js";
import { executeToolCalls } from "./tools.js";
import type {
  AgentConfig,
  AgentDump,
  AgentEvent,
  ToolCallInfo,
  ToolResultInfo,
} from "./types.js";

export class FsmAgent {
  readonly config: AgentConfig;
  readonly context: AgentContext;
  readonly process: FsmProcess;

  #abortController: AbortController | null = null;
  #eventQueue: AgentEvent[] = [];
  #pendingToolCalls: ToolCallInfo[] = [];
  #resolve: (() => void) | null = null;

  constructor(config: AgentConfig) {
    this.config = config;
    this.context = new AgentContext();
    this.process = new FsmProcess(createAgentFsmConfig());
    this.#wireHandlers();
  }

  async *run(prompt: string): AsyncGenerator<AgentEvent> {
    this.context.addUserMessage(prompt);
    this.context.turn++;
    this.#abortController = new AbortController();

    yield { type: "turn-start", turn: this.context.turn };

    // Dispatch "prompt" event to enter Generating state
    let running = await this.process.dispatch("prompt");

    // Drain events from state handlers until FSM reaches final state
    while (running) {
      // Yield any events queued by state handlers
      while (this.#eventQueue.length > 0) {
        yield this.#eventQueue.shift()!;
      }

      // Wait for the next state handler to complete
      running = await this.#waitForNext();
    }

    // Yield remaining events
    while (this.#eventQueue.length > 0) {
      yield this.#eventQueue.shift()!;
    }

    yield {
      type: "turn-end",
      turn: this.context.turn,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: this.context.totalTokens,
      },
    };

    yield { type: "done" };
    this.#abortController = null;
  }

  abort(): void {
    this.#abortController?.abort();
  }

  async dump(): Promise<AgentDump> {
    const fsmDump = await this.process.dump();
    return {
      messages: [...this.context.messages],
      fsmDump,
      turn: this.context.turn,
      totalTokens: this.context.totalTokens,
    };
  }

  async restore(dump: AgentDump): Promise<void> {
    this.context.messages = [...dump.messages];
    this.context.turn = dump.turn;
    this.context.totalTokens = dump.totalTokens;
    await this.process.restore(dump.fsmDump);
  }

  // ── Private: Wire FSM state handlers ───────────────────

  #wireHandlers(): void {
    this.process.onStateCreate((state: FsmState) => {
      if (state.key === "Generating") {
        state.onEnter(async () => {
          await this.#handleGenerating();
        });
      } else if (state.key === "Executing") {
        state.onEnter(async () => {
          await this.#handleExecuting();
        });
      }

      // Dump/restore support for context
      state.dump((_state, data) => {
        data.turn = this.context.turn;
        data.totalTokens = this.context.totalTokens;
        data.messageCount = this.context.messages.length;
      });
      state.restore((_state, data) => {
        if (typeof data.turn === "number") this.context.turn = data.turn;
        if (typeof data.totalTokens === "number")
          this.context.totalTokens = data.totalTokens;
      });
    });
  }

  async #handleGenerating(): Promise<void> {
    const signal =
      this.#abortController?.signal ?? new AbortController().signal;
    const system = buildSystemPrompt(
      this.config.system,
      this.config.skills ?? [],
    );
    const modelMessages = this.context.getModelMessages(
      this.config.maskAfterTurns,
    );

    // Check turn limit
    if (
      this.config.maxTurns != null &&
      this.context.turn > this.config.maxTurns
    ) {
      this.#emit({ type: "error", error: "Max turns exceeded" });
      await this.process.dispatch("error");
      return;
    }

    try {
      const gen = generate(this.config, system, modelMessages, signal);
      let result = await gen.next();
      while (!result.done) {
        this.#emit(result.value);
        result = await gen.next();
      }

      const { text, toolCalls, usage, finishReason } = result.value;
      this.context.addAssistantMessage(text, toolCalls, usage);

      if (toolCalls.length > 0) {
        this.#pendingToolCalls = toolCalls;
        await this.process.dispatch("tool-calls");
      } else {
        this.#emit({ type: "done", finishReason });
        await this.process.dispatch("complete");
      }
    } catch (err) {
      if (signal.aborted) {
        await this.process.dispatch("abort");
      } else {
        this.#emit({
          type: "error",
          error: err instanceof Error ? err.message : String(err),
        });
        await this.process.dispatch("error");
      }
    }
    this.#signalNext();
  }

  async #handleExecuting(): Promise<void> {
    const signal =
      this.#abortController?.signal ?? new AbortController().signal;
    const calls = this.#pendingToolCalls;
    this.#pendingToolCalls = [];

    try {
      const results: ToolResultInfo[] = await executeToolCalls(
        this.config.tools ?? [],
        calls,
        signal,
      );

      for (const result of results) {
        this.#emit({ type: "tool-result", toolResult: result });
      }

      this.context.addToolResultMessage(results);
      await this.process.dispatch("results");
    } catch (err) {
      this.#emit({
        type: "error",
        error: err instanceof Error ? err.message : String(err),
      });
      await this.process.dispatch("error");
    }
    this.#signalNext();
  }

  // ── Private: Event queue + signaling ───────────────────

  #emit(event: AgentEvent): void {
    this.#eventQueue.push(event);
  }

  #signalNext(): void {
    if (this.#resolve) {
      this.#resolve();
      this.#resolve = null;
    }
  }

  #waitForNext(): Promise<boolean> {
    // If there's a queued event already, check FSM status immediately
    if (this.#eventQueue.length > 0) {
      return Promise.resolve(this.process.running);
    }
    // Wait for the next state handler to signal
    return new Promise<boolean>((resolve) => {
      this.#resolve = () => resolve(this.process.running);
      // If the process already finished, resolve immediately
      if (!this.process.running) {
        this.#resolve = null;
        resolve(false);
      }
    });
  }
}
