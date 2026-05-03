import type { SelectionStrategy } from "../context/select-messages.js";
import type { AgentRuntime } from "./agent-runtime.js";
import { Session } from "./session.js";
import type { AgentDefinition } from "./types.js";

/**
 * `Agent` is a **definition** value: a named bundle of capabilities
 * (`tools`, `skills`, `systemPrompt`, `defaultModel`, sub-agents) that the
 * runtime can spin into one or more {@link Session}s.
 *
 * Agents are cheap to construct. Multiple {@link Session}s of the same
 * agent can run concurrently — each session has its own tree state.
 *
 * @example
 * ```ts
 * const analyst = runtime.createAgent({ name: "analyst", tools: [...] });
 * const session1 = analyst.createSession({ title: "Q1 review" });
 * const session2 = analyst.createSession({ title: "Q2 review" });
 * ```
 */
export class Agent {
  private readonly _definition: AgentDefinition;
  private readonly _runtime: AgentRuntime;
  private readonly _subAgents: Agent[] = [];
  private _selectionStrategy?: SelectionStrategy;

  /** @internal Use {@link AgentRuntime#createAgent} instead. */
  constructor(definition: AgentDefinition, runtime: AgentRuntime) {
    this._definition = { ...definition };
    this._runtime = runtime;
  }

  get name(): string {
    return this._definition.name;
  }

  /** Read-only definition. */
  get definition(): Readonly<AgentDefinition> {
    return this._definition;
  }

  /** @internal Sub-agents currently registered on this Agent. */
  get subAgents(): readonly Agent[] {
    return this._subAgents;
  }

  /** @internal Per-Agent override of the runtime-level selection strategy. */
  get selectionStrategy(): SelectionStrategy | undefined {
    return this._selectionStrategy;
  }

  /** @internal Runtime this Agent belongs to. */
  get runtime(): AgentRuntime {
    return this._runtime;
  }

  /**
   * Register a sub-agent. The sub-agent becomes available as a tool to
   * Sessions of this Agent — when called, the runtime constructs a child
   * Session of the sub-agent and streams its result back.
   */
  addSubAgent(child: Agent): this {
    this._subAgents.push(child);
    return this;
  }

  /** Per-Agent override of the runtime-level message selection strategy. */
  setSelectionStrategy(strategy: SelectionStrategy): this {
    this._selectionStrategy = strategy;
    return this;
  }

  /**
   * Spawn a new {@link Session} bound to this Agent. The session has an
   * empty state tree until it receives messages via `session.send(...)`
   * or its inbox. Pass `sessionId` to bind a specific id (otherwise the
   * runtime generates one at first save).
   */
  createSession(opts?: { title?: string; sessionId?: string }): Session {
    return new Session(this, this._runtime, opts?.sessionId, undefined, opts?.title);
  }
}
