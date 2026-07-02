import type { Inbox } from "../state/inbox.js";
import type { LogMessage } from "../state/log-message.js";
import type { SessionState } from "../state/session-state.js";
import type { SkillsModel } from "../state/skills-model.js";
import type { ToolRegistry } from "../state/tool-registry.js";
import type { Agent } from "./agent.js";
import type { Executor, ExecutorContext } from "./executor.js";
import { withFirstTurnTitle } from "./executor.js";
import type { TurnDriver } from "./turn-driver.js";

/**
 * Construction options for {@link Session}. Built by
 * {@link Agent#createSession} and {@link import("./agent-runtime.js").AgentRuntime#loadSession};
 * never assembled by callers directly.
 */
export interface SessionOptions {
  id: string;
  agent: Agent;
  state: SessionState;
  inbox: Inbox;
  tools: ToolRegistry;
  skills: SkillsModel;
  turnDriver: TurnDriver;
  /** The loop that drives this session. */
  executor: Executor;
  /** Best-effort title generator for the first turn. */
  generateTitle: (userText: string, signal?: AbortSignal) => Promise<string | undefined>;
  /** Persistence callback. Closes over the runtime + id. */
  save: (state: SessionState) => Promise<void>;
  /** MCP bridge tear-down hook (when MCP is configured on the runtime). */
  mcpUnsubscribe?: () => void;
}

/**
 * `Session` is a **runtime instance** of an {@link Agent}: it owns the
 * conversation state tree, the inbox, the per-session tool / skill views,
 * and the loop that drives the LLM via {@link TurnDriver}.
 *
 * Sessions are returned values — multiple Sessions of the same Agent run
 * concurrently. The runtime persists Sessions by id.
 *
 * @example
 * ```ts
 * const session = analyst.createSession({ title: "Q1 review" });
 * session.send("Look at /workspace/sales/Q1.csv and summarize");
 * for await (const log of session.run()) {
 *   console.log(log.kind, log.content);
 * }
 * await session.save();
 * ```
 */
export class Session {
  readonly id: string;
  readonly agent: Agent;
  readonly state: SessionState;
  readonly inbox: Inbox;
  readonly tools: ToolRegistry;
  readonly skills: SkillsModel;
  private readonly _turnDriver: TurnDriver;
  private readonly _executor: Executor;
  private readonly _generateTitle: SessionOptions["generateTitle"];
  private readonly _save: SessionOptions["save"];
  private _mcpUnsubscribe?: () => void;
  private _closed = false;

  /** @internal Use {@link Agent#createSession} or {@link import("./agent-runtime.js").AgentRuntime#loadSession}. */
  constructor(opts: SessionOptions) {
    this.id = opts.id;
    this.agent = opts.agent;
    this.state = opts.state;
    this.inbox = opts.inbox;
    this.tools = opts.tools;
    this.skills = opts.skills;
    this._turnDriver = opts.turnDriver;
    this._executor = opts.executor;
    this._generateTitle = opts.generateTitle;
    this._save = opts.save;
    this._mcpUnsubscribe = opts.mcpUnsubscribe;
  }

  /**
   * Push a user message into the inbox. The canonical way to feed a session.
   * Equivalent to `session.inbox.push({ role: "user", text })`.
   */
  send(text: string, opts?: { source?: string }): void {
    this.inbox.push({ role: "user", text, source: opts?.source });
  }

  /**
   * Run the agent loop. Delegates control flow to the agent's {@link Executor}
   * (default {@link import("./loop-executor.js").LoopExecutor}) over an
   * {@link ExecutorContext} exposing the inbox, state, and the bound turn
   * primitive. First-turn title generation is applied by
   * {@link withFirstTurnTitle} so consumers persisting on `turn-finish` see
   * `state.title` populated. Resolves when the inbox closes or the signal aborts.
   */
  async *run(signal?: AbortSignal): AsyncGenerator<LogMessage> {
    if (this._closed) throw new Error("Session: closed");
    const ctx: ExecutorContext = {
      inbox: this.inbox,
      state: this.state,
      drive: (message, sig) => this._turnDriver.drive(this.state, message, sig),
    };
    yield* withFirstTurnTitle(
      this._executor.run(ctx, signal),
      this.state,
      this._generateTitle,
      signal,
    );
  }

  /**
   * Persist the session tree to sessions storage. Resolves with the
   * session id (same as `this.id`). Optionally update the title.
   */
  async save(opts?: { title?: string }): Promise<string> {
    if (opts?.title !== undefined) {
      this.state.update({ title: opts.title });
    }
    await this._save(this.state);
    return this.id;
  }

  /**
   * Tear down: disconnect MCP bridge, close the session. Idempotent.
   */
  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    this._mcpUnsubscribe?.();
    this._mcpUnsubscribe = undefined;
  }
}
