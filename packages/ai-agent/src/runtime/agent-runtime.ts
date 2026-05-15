import type { ProviderV3 } from "@ai-sdk/provider";
import type { FilesApi } from "@statewalker/webrun-files";
import type { ToolSet } from "ai";
import { ConfigManager } from "../config/config-manager.js";
import { SecretsManager } from "../config/secrets-manager.js";
import { ContextWindow } from "../context/context-window.js";
import { createDefaultPinPolicy } from "../context/pin-policy.js";
import { selectHierarchical } from "../context/select-hierarchical.js";
import type { SelectionStrategy } from "../context/select-messages.js";
import { createTokenEstimator } from "../context/token-estimator.js";
import { createDefaultElisionPolicy } from "../context/tool-elision.js";
import { McpClientManager, type McpServerConfig } from "../mcp/mcp-client-manager.js";
import { FilesSessionManager } from "../sessions/files-session-manager.js";
import type { SessionMetadata } from "../sessions/metadata.js";
import type { SkillInfo } from "../skills/skill-types.js";
import { Agent } from "./agent.js";
import { AgentCatalog } from "./agent-catalog.js";
import { buildFilesSplit, normalizeFolderPath, type ResolvedPaths } from "./files-split.js";
import type { Session } from "./session.js";
import { SkillsLoader } from "./skills-loader.js";
import type {
  AgentDefinition,
  AgentRuntimeErrorContext,
  AgentRuntimeErrorHandler,
  AgentRuntimeOptions,
  BudgetCompactionOptions,
  ModelProviderInput,
  ToolInput,
} from "./types.js";

const DEFAULT_SYSTEM_PATH = "/.settings";
const DEFAULT_USER_PATH = "/";

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
  private _userPath: string = DEFAULT_USER_PATH;
  private _sessionsPath?: string;
  private _skillsPath?: string;
  private _agentsPath?: string;
  private _configPath?: string;

  private readonly _providers: ModelProviderInput[] = [];
  private readonly _toolInputs: ToolInput[] = [];
  private readonly _skills: SkillInfo[] = [];
  private _selectionStrategy?: SelectionStrategy;
  private _budgetCompaction?: BudgetCompactionOptions;
  private _mcpServers?: Record<string, McpServerConfig>;
  private _mcpConfigFile?: string;
  private _errorHandler: AgentRuntimeErrorHandler;

  private _built = false;
  private _systemFiles?: FilesApi;
  private _toolsFiles?: FilesApi;
  private _paths?: ResolvedPaths;
  private _config?: ConfigManager;
  private _secrets?: SecretsManager;
  private _provider?: ProviderV3;
  private _resolvedTools?: ToolSet;
  private _resolvedSkills?: SkillInfo[];
  private _sessions?: FilesSessionManager;
  private _mcp?: McpClientManager;

  private readonly _agentCatalog = new AgentCatalog();

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
   * Tools-visible root. Tools/skills can only see paths inside this subtree
   * and **never** inside `systemPath`, regardless. Default: `"/"`.
   */
  setUserPath(path: string): this {
    this._userPath = normalizeFolderPath(path);
    return this;
  }

  /** Override the sessions storage path (default: `<system>/sessions`). */
  setSessionsPath(path: string): this {
    this._sessionsPath = normalizeFolderPath(path);
    return this;
  }

  /** Override the skills folder (default: `<system>/skills`). */
  setSkillsPath(path: string): this {
    this._skillsPath = normalizeFolderPath(path);
    return this;
  }

  /** Override the agents folder (default: `<system>/agents`). */
  setAgentsPath(path: string): this {
    this._agentsPath = normalizeFolderPath(path);
    return this;
  }

  /** Override the config folder (default: `<system>/config`). */
  setConfigPath(path: string): this {
    this._configPath = normalizeFolderPath(path);
    return this;
  }

  /**
   * Override the tools folder (default: `<system>/tools`). Reserved for
   * future on-disk tool loading; setting this value has no effect today
   * but the API is stable.
   */
  setToolsPath(_path: string): this {
    // TODO: wire on-disk tool definitions when the format is settled.
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

  /**
   * Install a fixed message-selection strategy on every Session this runtime
   * hosts. Mutually exclusive with {@link AgentRuntime#setBudgetCompaction}.
   */
  setSelectionStrategy(strategy: SelectionStrategy): this {
    if (this._budgetCompaction) {
      this._errorHandler(
        new Error("setSelectionStrategy overrides prior setBudgetCompaction configuration"),
      );
      this._budgetCompaction = undefined;
    }
    this._selectionStrategy = strategy;
    return this;
  }

  /**
   * Install hierarchical selection + compaction on every Session.
   * Mutually exclusive with {@link AgentRuntime#setSelectionStrategy}.
   */
  setBudgetCompaction(options: BudgetCompactionOptions): this {
    if (this._selectionStrategy) {
      this._errorHandler(
        new Error("setBudgetCompaction overrides prior setSelectionStrategy configuration"),
      );
      this._selectionStrategy = undefined;
    }
    this._budgetCompaction = options;
    return this;
  }

  /** Configure MCP servers inline. Mutually exclusive with `setMcpConfigFile`. */
  setMcpServers(config: Record<string, McpServerConfig>): this {
    this._mcpServers = config;
    return this;
  }

  /** Load MCP server configs from a file at `path` (system view). */
  setMcpConfigFile(path: string): this {
    this._mcpConfigFile = path;
    return this;
  }

  /**
   * Replace the runtime-wide error handler. The handler is invoked for:
   * - build-phase configuration errors,
   * - {@link FilteredFilesApi} visibility violations (with `{ path }`),
   * - MCP server failures (with `{ server }`).
   * Default handler is `console.warn`.
   */
  setErrorHandler(handler: AgentRuntimeErrorHandler): this {
    this._errorHandler = handler;
    if (this._mcp) this._mcp.setErrorHandler((e, c) => handler(e, c));
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
    this._secrets = new SecretsManager(this._config);
    this._provider = this._resolveProvider();
    this._sessions = new FilesSessionManager(this._systemFiles, this._paths.sessions);
    this._resolvedTools = await this._resolveTools();
    this._resolvedSkills = await new SkillsLoader().load(
      this._systemFiles,
      this._paths.skills,
      this._skills,
      this._errorHandler,
    );
    this._mcp = await this._startMcp();
    await this._agentCatalog.loadFromDisk(
      this._systemFiles,
      this._paths.agents,
      this,
      this._errorHandler,
    );
    this._built = true;
    return this;
  }

  /** Build the FilesApi split, routing geometry errors through the handler. */
  private _buildSplit(): ReturnType<typeof buildFilesSplit> {
    try {
      return buildFilesSplit(this._rootFiles, {
        systemPath: this._systemPath,
        userPath: this._userPath,
        overrides: {
          ...(this._sessionsPath !== undefined && { sessions: this._sessionsPath }),
          ...(this._skillsPath !== undefined && { skills: this._skillsPath }),
          ...(this._agentsPath !== undefined && { agents: this._agentsPath }),
          ...(this._configPath !== undefined && { config: this._configPath }),
        },
      });
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

  /**
   * Connect MCP servers when configured. Returns the manager (or undefined
   * when neither inline servers nor a config file was set).
   */
  private async _startMcp(): Promise<McpClientManager | undefined> {
    if (!this._mcpServers && !this._mcpConfigFile) return undefined;
    const mcp = new McpClientManager().setErrorHandler((e, c) =>
      this._errorHandler(e as Error, c as AgentRuntimeErrorContext),
    );
    let serverConfigs = this._mcpServers;
    if (this._mcpConfigFile) {
      try {
        const cfg = await this._requireConfig().load<{
          servers: Record<string, McpServerConfig>;
        }>(this._mcpConfigFile);
        if (cfg?.servers) serverConfigs = { ...serverConfigs, ...cfg.servers };
      } catch (err) {
        this._errorHandler(err as Error, { path: this._mcpConfigFile });
      }
    }
    if (serverConfigs) await mcp.loadServers(serverConfigs);
    return mcp;
  }

  private _requireConfig(): ConfigManager {
    if (!this._config) throw new Error("unreachable");
    return this._config;
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
    return this._agentCatalog.register(def, this);
  }

  /** Return a registered Agent by name, or `undefined`. */
  getAgent(name: string): Agent | undefined {
    return this._agentCatalog.get(name);
  }

  /** Return all registered Agents. */
  agents(): Agent[] {
    return this._agentCatalog.all();
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
    const known = persistedAgentName ? this._agentCatalog.get(persistedAgentName) : undefined;
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

  get secrets(): SecretsManager {
    this._assertBuilt();
    if (!this._secrets) throw new Error("unreachable");
    return this._secrets;
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
  get selectionStrategy(): SelectionStrategy | undefined {
    return this._selectionStrategy;
  }

  /**
   * Return a factory that builds a per-session {@link ContextWindow} from
   * the runtime-wide defaults (selection strategy, budget compaction, etc.).
   * Per-agent overrides are applied by `runtime/Session` on top of the
   * factory output.
   *
   * @internal
   */
  contextDefaults(opts: {
    systemPromptTemplate?: string;
    selectStrategy?: SelectionStrategy;
  }): ContextWindow {
    this._assertBuilt();
    if (!this._provider) throw new Error("unreachable");

    const bc = this._budgetCompaction;
    if (bc) {
      const estimator = bc.estimator ?? createTokenEstimator();
      const pinPolicy = bc.pinPolicy ?? createDefaultPinPolicy();
      const elisionPolicy = bc.elisionPolicy ?? createDefaultElisionPolicy();
      const keepRecentTurns = bc.keepRecentTurns ?? 4;
      const defaultSelect = selectHierarchical({
        budgetTokens: bc.budgetTokens,
        keepRecentTurns,
        pinPolicy,
        elisionPolicy,
        estimator,
      });
      return new ContextWindow({
        provider: this._provider,
        model: "",
        selectStrategy: opts.selectStrategy ?? defaultSelect,
        ...(opts.systemPromptTemplate !== undefined && {
          systemPromptTemplate: opts.systemPromptTemplate,
        }),
        estimator,
        pinPolicy,
        elisionPolicy,
        summarizer: bc.summarizer,
        budgetTokens: bc.budgetTokens,
        keepRecentTurns,
        ...(bc.groupSize !== undefined && { groupSize: bc.groupSize }),
        ...(bc.depthPromoteThreshold !== undefined && {
          depthPromoteThreshold: bc.depthPromoteThreshold,
        }),
        ...(bc.maxPassesPerCompact !== undefined && {
          maxPassesPerCompact: bc.maxPassesPerCompact,
        }),
      });
    }

    return new ContextWindow({
      provider: this._provider,
      model: "",
      ...(opts.selectStrategy !== undefined && { selectStrategy: opts.selectStrategy }),
      ...(this._selectionStrategy !== undefined &&
        opts.selectStrategy === undefined && { selectStrategy: this._selectionStrategy }),
      ...(opts.systemPromptTemplate !== undefined && {
        systemPromptTemplate: opts.systemPromptTemplate,
      }),
    });
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
    if (
      !this._toolsFiles ||
      !this._systemFiles ||
      !this._config ||
      !this._secrets ||
      !this._provider ||
      !this._sessions
    ) {
      throw new Error("unreachable");
    }
    return {
      files: this._toolsFiles,
      systemFiles: this._systemFiles,
      config: this._config,
      secrets: this._secrets,
      sessions: this._sessions,
      provider: this._provider,
      model: "",
    };
  }
}
