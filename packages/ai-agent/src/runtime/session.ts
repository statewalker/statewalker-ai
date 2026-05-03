import { SnowflakeId } from "@statewalker/shared-ids";
import { SubAgentTool } from "../builder/sub-agent-tool.js";
import { AgentController } from "../controller/agent-controller.js";
import { bridgeMcpTools } from "../mcp/bridge-mcp-tools.js";
import type { Inbox } from "../state/inbox.js";
import type { LogMessage } from "../state/log-message.js";
import { createAgentNodeFactory } from "../state/node-factory.js";
import { NodeType } from "../state/node-types.js";
import type { Session as SessionNode } from "../state/session.js";
import type { SkillsModel } from "../state/skills-model.js";
import type { ToolRegistry } from "../state/tool-registry.js";
import type { Agent } from "./agent.js";
import type { AgentRuntime } from "./agent-runtime.js";

const idGen = new SnowflakeId();

/**
 * `Session` is a **runtime instance** of an {@link Agent}: it owns the
 * conversation state tree, the inbox, the per-session tool / skill views,
 * and the loop that drives the LLM.
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
  readonly state: SessionNode;
  private readonly _runtime: AgentRuntime;
  private readonly _controller: AgentController;
  private _mcpUnsubscribe?: () => void;
  private _closed = false;

  /** @internal Use {@link Agent#createSession} or {@link AgentRuntime#loadSession}. */
  constructor(
    agent: Agent,
    runtime: AgentRuntime,
    sessionId?: string,
    existingTree?: SessionNode,
    title?: string,
  ) {
    this.agent = agent;
    this._runtime = runtime;
    this.id = sessionId ?? idGen.generate();

    if (existingTree) {
      this.state = existingTree;
      // Adopt the bound id so saves write back to the same location.
      existingTree.data.id = this.id;
    } else {
      const factory = createAgentNodeFactory();
      this.state = factory<SessionNode>({
        type: NodeType.session,
        id: this.id,
        props: title ? { title } : {},
      });
    }

    // Build the controller config from runtime + agent.
    const def = agent.definition;
    const budget = runtime.budgetCompactionOptions;
    this._controller = new AgentController({
      provider: runtime.provider,
      model: def.defaultModel ?? "",
      session: this.state,
      systemPrompt: def.systemPrompt,
      maxSteps: def.maxSteps,
      maxOutputTokens: def.maxOutputTokens,
      select: agent.selectionStrategy ?? budget?.select ?? runtime.selectionStrategy,
      compactor: budget?.compactor,
      compactOptions: budget?.compactOptions,
    });

    // Per-session tool view: filter the runtime-level tools by the Agent's
    // declared tool names (or all if none declared).
    const allowedTools = def.tools;
    const runtimeTools = runtime.resolvedTools;
    for (const [name, tool] of Object.entries(runtimeTools)) {
      if (!allowedTools || allowedTools.includes(name)) {
        this._controller.tools.register(name, tool);
      }
    }

    // Per-session skill view.
    const allowedSkills = def.skills;
    if (allowedSkills && allowedSkills.length > 0) {
      for (const skill of runtime.resolvedSkills) {
        if (allowedSkills.includes(skill.name)) {
          this._controller.skills.register(skill);
        }
      }
    }

    // Sub-agents — register each child Agent as a tool. The SubAgentTool
    // class is reused as an internal helper here.
    for (const child of agent.subAgents) {
      const ctx = this._controllerContext();
      const factoryCompat = (parent: typeof ctx) => {
        // This sub-agent path is a stop-gap until sub-agents move fully
        // into the runtime. It builds an AgentBuilder under the hood.
        // TODO: replace with a runtime-native sub-agent invocation.
        void parent;
        throw new Error(
          `Sub-agent "${child.name}" cannot be invoked from runtime-API sessions yet — TODO: runtime-native sub-agent wiring`,
        );
      };
      const tool = new SubAgentTool(child.name, factoryCompat, ctx);
      this._controller.tools.register(child.name, tool.asTool());
    }

    // MCP tools — sync into this session's tool registry.
    const mcp = runtime.mcp;
    if (mcp) {
      this._mcpUnsubscribe = bridgeMcpTools(mcp, this._controller.tools);
    }
  }

  /** Per-session inbox. Push user/system messages here. */
  get inbox(): Inbox {
    return this._controller.inbox;
  }

  /** Per-session tool registry (filtered view of the runtime's tools). */
  get tools(): ToolRegistry {
    return this._controller.tools;
  }

  /** Per-session skill registry (filtered view of the runtime's skills). */
  get skills(): SkillsModel {
    return this._controller.skills;
  }

  /**
   * Push a user message into the inbox. The canonical way to feed a session.
   * Equivalent to `session.inbox.push({ role: "user", text })`.
   */
  send(text: string, opts?: { source?: string }): void {
    this._controller.inbox.push({ role: "user", text, source: opts?.source });
  }

  /**
   * Run the agent loop. Resolves when the loop completes or the signal
   * aborts. Yields {@link LogMessage}s as the loop progresses.
   */
  async *run(signal?: AbortSignal): AsyncGenerator<LogMessage> {
    if (this._closed) throw new Error("Session: closed");
    yield* this._controller.run(signal);
  }

  /**
   * Persist the session tree to sessions storage. Resolves with the
   * session id (same as `this.id`). Optionally update the title.
   */
  async save(opts?: { title?: string }): Promise<string> {
    if (opts?.title !== undefined) {
      this.state.update({ title: opts.title });
    }
    await this._runtime.saveSession(this.id, this.state);
    return this.id;
  }

  /**
   * Tear down: cancel pending tool calls, disconnect MCP bridge, close
   * the session. Idempotent.
   */
  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    this._mcpUnsubscribe?.();
    this._mcpUnsubscribe = undefined;
  }

  // ─── Internal ────────────────────────────────────────────────────────

  private _controllerContext(): import("../config/types.js").AgentContext {
    return {
      files: this._runtime.files,
      systemFiles: this._runtime.systemFiles,
      config: this._runtime.config,
      secrets: this._runtime.secrets,
      sessions: {
        // The legacy SessionManager interface — sub-agents that depend on
        // it get a thin shim backed by the runtime's own session storage.
        create: async () => {
          throw new Error("Session.context.sessions.create: not supported in runtime API");
        },
        load: (id) => this._runtime.loadSession(id).then((s) => s.state),
        save: (id, sess) => this._runtime.saveSession(id, sess),
        list: () => this._runtime.listSessions(),
        delete: (id) => this._runtime.deleteSession(id),
        exists: () => Promise.resolve(false),
      },
      provider: this._runtime.provider,
      model: this.agent.definition.defaultModel ?? "",
      modelManager: this._runtime.models,
    };
  }
}
