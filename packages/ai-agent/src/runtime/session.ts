import { SnowflakeId } from "@statewalker/shared-ids";
import { generateText } from "ai";
import { bridgeMcpTools } from "../mcp/bridge-mcp-tools.js";
import { Inbox } from "../state/inbox.js";
import type { LogMessage } from "../state/log-message.js";
import { createAgentNodeFactory } from "../state/node-factory.js";
import { NodeType } from "../state/node-types.js";
import type { Session as SessionNode } from "../state/session.js";
import { SkillsModel } from "../state/skills-model.js";
import { ToolRegistry } from "../state/tool-registry.js";
import { createListSkillsTool } from "../tools/list-skills-tool.js";
import { createListToolsTool } from "../tools/list-tools-tool.js";
import { createUseSkillsTool } from "../tools/use-skills-tool.js";
import type { Agent } from "./agent.js";
import type { AgentRuntime } from "./agent-runtime.js";
import { TurnDriver } from "./turn-driver.js";

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
  readonly inbox: Inbox;
  readonly tools: ToolRegistry;
  readonly skills: SkillsModel;
  private readonly _runtime: AgentRuntime;
  private readonly _turnDriver: TurnDriver;
  private readonly _model: string;
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

    this.inbox = new Inbox();
    this.tools = new ToolRegistry();
    this.skills = new SkillsModel();

    // Per-session tool view: filter the runtime-level tools by the Agent's
    // declared tool names (or all if none declared).
    const def = agent.definition;
    const allowedTools = def.tools;
    for (const [name, tool] of Object.entries(runtime.resolvedTools)) {
      if (!allowedTools || allowedTools.includes(name)) {
        this.tools.register(name, tool);
      }
    }

    // Per-session skill view: filter by allowed names if declared, else
    // pass through all runtime skills. An undefined `skills` field means
    // "all skills" (NOT "no skills").
    const allowedSkills = def.skills;
    for (const skill of runtime.resolvedSkills) {
      if (!allowedSkills || allowedSkills.includes(skill.name)) {
        this.skills.register(skill);
      }
    }

    // Register built-in tools (list_tools always; list_skills + use_skills
    // when any skills are available). Done once at construction, not
    // lazily on first run() — registry membership is session-scoped.
    this._model = def.defaultModel ?? "";
    this.tools.register("list_tools", createListToolsTool(this.tools));
    if (this.skills.size > 0) {
      this.tools.register("list_skills", createListSkillsTool(this.skills));
      this.tools.register(
        "use_skills",
        createUseSkillsTool({
          skills: this.skills,
          provider: runtime.provider,
          model: this._model,
        }),
      );
    }

    // Sub-agents — TODO: runtime-native sub-agent invocation. The legacy
    // SubAgentTool class lived in src/builder/ and depended on AgentBuilder
    // to materialise the child agent on demand. Now that builder/ is gone,
    // we need a runtime-native equivalent. Until consumers actually use
    // sub-agents through the runtime API, registering one throws here.
    if (agent.subAgents.length > 0) {
      throw new Error(
        `Sub-agents not supported yet on runtime API (agent "${agent.name}" declared ${agent.subAgents.length})`,
      );
    }

    // MCP tools — sync into this session's tool registry.
    const mcp = runtime.mcp;
    if (mcp) {
      this._mcpUnsubscribe = bridgeMcpTools(mcp, this.tools);
    }

    // Build the per-session ContextWindow from runtime defaults + agent
    // overrides, then the TurnDriver that advances state one Turn per call.
    const contextWindow = runtime.contextDefaults({
      ...(def.systemPrompt !== undefined && { systemPromptTemplate: def.systemPrompt }),
      ...(agent.selectionStrategy !== undefined && { selectStrategy: agent.selectionStrategy }),
    });
    this._turnDriver = new TurnDriver({
      provider: runtime.provider,
      model: this._model,
      contextWindow,
      tools: this.tools,
      skills: this.skills,
      ...(def.maxSteps !== undefined && { maxSteps: def.maxSteps }),
      ...(def.maxOutputTokens !== undefined && { maxOutputTokens: def.maxOutputTokens }),
    });
  }

  /**
   * Push a user message into the inbox. The canonical way to feed a session.
   * Equivalent to `session.inbox.push({ role: "user", text })`.
   */
  send(text: string, opts?: { source?: string }): void {
    this.inbox.push({ role: "user", text, source: opts?.source });
  }

  /**
   * Run the agent loop. Drains the {@link Inbox} and delegates each message
   * to the {@link TurnDriver}. On the first turn, generates a session title
   * via `generateText` before forwarding the buffered `turn-finish` event,
   * so consumers persisting on `turn-finish` see `state.title` populated.
   * Resolves when the inbox closes or the signal aborts.
   */
  async *run(signal?: AbortSignal): AsyncGenerator<LogMessage> {
    if (this._closed) throw new Error("Session: closed");
    for (;;) {
      const message = await this.inbox.take(signal);
      if (!message) break;

      const isFirstTurn = this.state.turns.length === 0;
      let pendingFinish: LogMessage | undefined;
      for await (const ev of this._turnDriver.drive(this.state, message, signal)) {
        if (ev.type === "turn-finish") {
          pendingFinish = ev;
          continue;
        }
        yield ev;
      }
      if (isFirstTurn && !this.state.title) {
        try {
          this.state.title = await this.generateTitle(message.text, signal);
        } catch {
          // Title generation is best-effort — do not propagate errors.
        }
      }
      if (pendingFinish) yield pendingFinish;
    }
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
   * Tear down: disconnect MCP bridge, close the session. Idempotent.
   */
  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    this._mcpUnsubscribe?.();
    this._mcpUnsubscribe = undefined;
  }

  /**
   * Generate a short title for the session based on the user's first
   * message. Runs a lightweight LLM call; swallows errors silently.
   */
  private async generateTitle(userText: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      const { text } = await generateText({
        model: this._runtime.provider.languageModel(this._model),
        system:
          "Generate a short title (max 6 words) for a conversation that starts with the following user message. Reply with the title only, no quotes or punctuation at the end.",
        messages: [{ role: "user", content: userText }],
        abortSignal: signal,
      });
      return text.trim();
    } catch {
      return undefined;
    }
  }
}
