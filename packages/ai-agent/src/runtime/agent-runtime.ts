import type { ProviderV3 } from "@ai-sdk/provider";
import { type FilesApi, readText } from "@statewalker/webrun-files";
import type { ToolSet } from "ai";
import { ConfigManager } from "../config/config-manager.js";
import { McpClientManager, type McpServerConfig } from "../mcp/mcp-client-manager.js";
import { FilesSessionManager } from "../sessions/files-session-manager.js";
import type { SessionMetadata } from "../sessions/metadata.js";
import { parseSkillMarkdown } from "../skills/skill-parser.js";
import type { SkillInfo } from "../skills/skill-types.js";
import { Agent } from "./agent.js";
import { buildFilesSplit, normalizeFolderPath, type ResolvedPaths } from "./files-split.js";
import type { Session } from "./session.js";
import type {
  AgentDefinition,
  AgentRuntimeErrorContext,
  AgentRuntimeErrorHandler,
  AgentRuntimeOptions,
  ModelProviderInput,
  ToolInput,
} from "./types.js";

const DEFAULT_SYSTEM_PATH = "/.settings";

const defaultErrorHandler: AgentRuntimeErrorHandler = (error, ctx) => {
  console.warn(
    "[AgentRuntime]",
    ctx?.path ? `path=${ctx.path}` : ctx?.server ? `server=${ctx.server}` : "",
    error,
  );
};

/**
 * `AgentRuntime` is the official entry point for `@statewalker/ai-agent`.
 *
 * The runtime owns the shared state of an "agent project":
 * - a root {@link FilesApi} split into a **system view** (full visibility,
 *   used by the runtime itself for config / sessions / agent / skill
 *   loading) and a **tools view** (a `FilteredFilesApi` over the same root
 *   with the system path-tree hidden — given to tools and skills);
 * - one or more model providers, unioned;
 * - a tool registry shared across all agents this runtime hosts;
 * - a skill registry shared across all agents;
 * - per-agent definitions registered via {@link AgentRuntime#createAgent};
 * - a session store for persistence.
 *
 * Three-tier model:
 *
 * ```
 * AgentRuntime  ─→  Agent (definition)  ─→  Session (runtime instance)
 * ```
 *
 * @example
 * ```ts
 * const runtime = await new AgentRuntime({ files })
 *   .addModelProvider(new WebLLMProvider())
 *   .setSystemPath(".settings/")
 *   .addTools(myTools)
 *   .addSkills(...mySkills)
 *   .build();
 *
 * const dataScientist = runtime.createAgent({
 *   name: "data-scientist",
 *   tools: ["read_file", "grep_files"],
 *   skills: ["analyze-csv"],
 * });
 *
 * const session = dataScientist.createSession({ title: "Q1 review" });
 * for await (const log of session.run()) console.log(log.kind);
 * await session.save();
 * ```
 */
export class AgentRuntime {
  private readonly _rootFiles: FilesApi;
  private _systemPath: string = DEFAULT_SYSTEM_PATH;

  private readonly _providers: ModelProviderInput[] = [];
  private readonly _toolInputs: ToolInput[] = [];
  private readonly _skills: SkillInfo[] = [];
  private _mcpServers?: Record<string, McpServerConfig>;
  private _errorHandler: AgentRuntimeErrorHandler;

  private _built = false;
  private _systemFiles?: FilesApi;
  private _toolsFiles?: FilesApi;
  private _paths?: ResolvedPaths;
  private _config?: ConfigManager;
  private _provider?: ProviderV3;
  private _resolvedTools?: ToolSet;
  private _resolvedSkills?: SkillInfo[];
  private _sessions?: FilesSessionManager;
  private _mcp?: McpClientManager;

  private readonly _agents = new Map<string, Agent>();

  /** Construct a new `AgentRuntime`. Use the fluent setters then call `build()`. */
  constructor(opts: AgentRuntimeOptions) {
    this._rootFiles = opts.files;
    this._errorHandler = opts.errorHandler ?? defaultErrorHandler;
  }

  // ─── Fluent setup ──────────────────────────────────────────────────────

  /**
   * System path-tree. Config, tools, skills, agents, sessions live here by
   * default. Hidden from agent-facing tools via `FilteredFilesApi`.
   * Default: `"/.settings"`.
   */
  setSystemPath(path: string): this {
    this._systemPath = normalizeFolderPath(path);
    return this;
  }

  /**
   * Register one or more model providers. Multiple calls are additive — at
   * `build()` the runtime constructs a single composite provider whose
   * model list is the union of all registered providers.
   *
   * Callers holding a `ModelManager` pass `modelManager.provider`.
   */
  addModelProvider(...providers: ModelProviderInput[]): this {
    this._providers.push(...providers);
    return this;
  }

  /** Register tools (build-time). Accepts {@link ToolSet} or {@link ToolFactory}. */
  addTools(...tools: ToolInput[]): this {
    this._toolInputs.push(...tools);
    return this;
  }

  /** Register skills (build-time). The skills folder is auto-loaded too. */
  addSkills(...skills: SkillInfo[]): this {
    this._skills.push(...skills);
    return this;
  }

  /** Configure MCP servers inline. */
  setMcpServers(config: Record<string, McpServerConfig>): this {
    this._mcpServers = config;
    return this;
  }

  // ─── Materialization ───────────────────────────────────────────────────

  /**
   * Materialize the runtime: build the FilesApi split, resolve providers,
   * load skills + agent definitions from disk, connect MCP. Idempotent
   * after the first successful call.
   *
   * @throws if the FilesApi split is degenerate (system covers root with
   *   default user path) or if no provider is configured.
   */
  async build(): Promise<this> {
    if (this._built) return this;
    const split = this._buildSplit();
    this._systemFiles = split.systemFiles;
    this._toolsFiles = split.toolsFiles;
    this._paths = split.paths;
    this._config = new ConfigManager(this._systemFiles, this._paths.config);
    this._provider = this._resolveProvider();
    this._sessions = new FilesSessionManager(this._systemFiles, this._paths.sessions);
    this._resolvedTools = await this._resolveTools();
    this._resolvedSkills = await this._loadSkillsFromDisk(
      this._systemFiles,
      this._paths.skills,
      this._skills,
    );
    this._mcp = await this._startMcp();
    await this._loadAgentsFromDisk(this._systemFiles, this._paths.agents);
    this._built = true;
    return this;
  }

  /**
   * Walk `<systemFiles>/<agentsPath>` and register each `*.md` file as an
   * Agent definition. Programmatically-registered agents win over disk-loaded
   * ones (already-present names are skipped). Per-file errors flow through
   * the runtime's `errorHandler` without aborting the walk.
   */
  private async _loadAgentsFromDisk(systemFiles: FilesApi, agentsPath: string): Promise<void> {
    if (!(await systemFiles.exists(agentsPath))) return;
    for await (const entry of systemFiles.list(agentsPath)) {
      if (entry.kind !== "file" || !entry.name.endsWith(".md")) continue;
      try {
        const text = await readText(systemFiles, entry.path);
        const def = parseAgentMarkdown(text, entry.name.replace(/\.md$/, ""));
        if (def && !this._agents.has(def.name)) {
          this._agents.set(def.name, new Agent(def, this));
        }
      } catch (err) {
        this._errorHandler(err as Error, { path: entry.path } as AgentRuntimeErrorContext);
      }
    }
  }

  /**
   * Resolve the runtime's `SkillInfo[]` from disk plus manually-registered
   * skills. Manual skills come first; disk-loaded skills append. Per-file
   * errors flow through the runtime's `errorHandler` without aborting.
   * Returns the manual list unchanged when the folder doesn't exist.
   */
  private async _loadSkillsFromDisk(
    systemFiles: FilesApi,
    skillsPath: string,
    manualSkills: SkillInfo[],
  ): Promise<SkillInfo[]> {
    const skills: SkillInfo[] = [...manualSkills];
    if (!(await systemFiles.exists(skillsPath))) return skills;
    for await (const entry of systemFiles.list(skillsPath)) {
      if (entry.kind !== "file" || !entry.name.endsWith(".md")) continue;
      try {
        const text = await readText(systemFiles, entry.path);
        const skill = parseSkillMarkdown(text, entry.path);
        if (skill) skills.push(skill);
      } catch (err) {
        this._errorHandler(err as Error, { path: entry.path } as AgentRuntimeErrorContext);
      }
    }
    return skills;
  }

  /** Build the FilesApi split, routing geometry errors through the handler. */
  private _buildSplit(): ReturnType<typeof buildFilesSplit> {
    try {
      return buildFilesSplit(this._rootFiles, { systemPath: this._systemPath });
    } catch (err) {
      this._errorHandler(err as Error, { path: "/" });
      throw err;
    }
  }

  /** First registered provider wins. TODO: union of multiple providers. */
  private _resolveProvider(): ProviderV3 {
    const first = this._providers[0];
    if (!first) {
      const err = new Error("AgentRuntime: no model provider configured. Use .addModelProvider()");
      this._errorHandler(err);
      throw err;
    }
    return first;
  }

  /** Walk `_toolInputs`, calling factory inputs with the agent context. */
  private async _resolveTools(): Promise<ToolSet> {
    const tools: ToolSet = {};
    for (const input of this._toolInputs) {
      const set = typeof input === "function" ? await input(this._buildAgentContext()) : input;
      Object.assign(tools, set);
    }
    return tools;
  }

  /** Connect MCP servers when `setMcpServers(...)` was called. */
  private async _startMcp(): Promise<McpClientManager | undefined> {
    if (!this._mcpServers) return undefined;
    const mcp = new McpClientManager().setErrorHandler((e, c) =>
      this._errorHandler(e as Error, c as AgentRuntimeErrorContext),
    );
    await mcp.loadServers(this._mcpServers);
    return mcp;
  }

  // ─── Agent definitions ─────────────────────────────────────────────────

  /**
   * Register and return an {@link Agent} definition. Names must be unique;
   * re-registering an existing name throws.
   *
   * @example
   * ```ts
   * const analyst = runtime.createAgent({
   *   name: "analyst",
   *   tools: ["search", "read_file"],
   *   defaultModel: "claude-haiku-4-5",
   * });
   * ```
   */
  createAgent(def: AgentDefinition): Agent {
    if (this._agents.has(def.name)) {
      throw new Error(`AgentRuntime: agent already registered: ${def.name}`);
    }
    const agent = new Agent(def, this);
    this._agents.set(def.name, agent);
    return agent;
  }

  /** Return a registered Agent by name, or `undefined`. */
  getAgent(name: string): Agent | undefined {
    return this._agents.get(name);
  }

  /** Return all registered Agents. */
  agents(): Agent[] {
    return [...this._agents.values()];
  }

  // ─── Sessions ──────────────────────────────────────────────────────────

  /**
   * Resume an existing session by id.
   *
   * The agent name is not yet persisted as a structured field, so the
   * session is bound to a synthetic `__resumed__` Agent unless the caller
   * has previously registered an agent with the matching name via
   * {@link AgentRuntime#createAgent}. Once the persistence format records
   * the agent name, this resolution becomes deterministic.
   */
  async loadSession(sessionId: string): Promise<Session> {
    this._assertBuilt();
    const existingState = await this._requireSessions().load(sessionId);
    // Best-effort: if the persisted state's `agent` prop is a known agent,
    // bind the resumed Session to it. Otherwise fall back to a synthetic.
    const persistedAgentName = (existingState.props?.agent as string | undefined) ?? undefined;
    const known = persistedAgentName ? this._agents.get(persistedAgentName) : undefined;
    const agent = known ?? new Agent({ name: "__resumed__" }, this);
    return agent.createSession({ sessionId, existingState });
  }

  /** List session metadata (id, title, updatedAt) — newest first. */
  async listSessions(): Promise<SessionMetadata[]> {
    this._assertBuilt();
    return this._requireSessions().list();
  }

  /** Delete a session by id. */
  async deleteSession(sessionId: string): Promise<boolean> {
    this._assertBuilt();
    return this._requireSessions().delete(sessionId);
  }

  /** Read a session's metadata (id, title, modelRef, …). */
  async getSessionMetadata(sessionId: string): Promise<SessionMetadata | undefined> {
    this._assertBuilt();
    return this._requireSessions().getMetadata(sessionId);
  }

  /** Set (or clear with `null`) the per-session `modelRef`. The chat
   * composer's dropdown writes through this on user selection. */
  async setSessionModelRef(
    sessionId: string,
    modelRef: { connectionId: string; modelId: string } | null,
  ): Promise<void> {
    this._assertBuilt();
    await this._requireSessions().setModelRef(sessionId, modelRef);
  }

  // ─── Read-only views (used by Agent / Session internally) ─────────────

  /** Tools-view FilesApi (the one exposed to agents and skills). */
  get files(): FilesApi {
    this._assertBuilt();
    if (!this._toolsFiles) throw new Error("unreachable");
    return this._toolsFiles;
  }

  /** System-view FilesApi (full visibility — runtime-internal). */
  get systemFiles(): FilesApi {
    this._assertBuilt();
    if (!this._systemFiles) throw new Error("unreachable");
    return this._systemFiles;
  }

  get config(): ConfigManager {
    this._assertBuilt();
    if (!this._config) throw new Error("unreachable");
    return this._config;
  }

  get mcp(): McpClientManager | undefined {
    return this._mcp;
  }

  /** Internal: provider used by sessions. */
  /** @internal */
  get provider(): ProviderV3 {
    this._assertBuilt();
    if (!this._provider) throw new Error("unreachable");
    return this._provider;
  }

  /** @internal */
  get resolvedTools(): ToolSet {
    this._assertBuilt();
    return this._resolvedTools ?? {};
  }

  /** @internal */
  get resolvedSkills(): SkillInfo[] {
    this._assertBuilt();
    return this._resolvedSkills ?? [];
  }

  /** @internal */
  get errorHandler(): AgentRuntimeErrorHandler {
    return this._errorHandler;
  }

  /** @internal */
  saveSession(
    sessionId: string,
    tree: import("../state/session-state.js").SessionState,
  ): Promise<void> {
    return this._requireSessions().save(sessionId, tree);
  }

  // ─── Private helpers ───────────────────────────────────────────────────

  private _assertBuilt(): void {
    if (!this._built) {
      throw new Error("AgentRuntime: call build() before using runtime APIs");
    }
  }

  private _requireSessions(): FilesSessionManager {
    if (!this._sessions) throw new Error("unreachable");
    return this._sessions;
  }

  private _buildAgentContext(): import("../config/types.js").AgentContext {
    if (!this._toolsFiles) throw new Error("unreachable");
    return { files: this._toolsFiles };
  }
}

// ── Module-private helpers ───────────────────────────────────────────────

/**
 * Parse an Agent definition file (markdown with key=value frontmatter
 * delimited by `---` lines). Returns `null` if the file is not recognisable
 * as an Agent definition — the caller treats `null` as "skip".
 */
function parseAgentMarkdown(text: string, fallbackName: string): AgentDefinition | null {
  const parsed = parseSkillMarkdown(text, fallbackName);
  if (!parsed) return null;
  const def: AgentDefinition = { name: parsed.name ?? fallbackName };
  if (parsed.description) def.systemPrompt = parsed.content ?? parsed.description;
  return def;
}
