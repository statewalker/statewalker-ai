import type { ProviderV3 } from "@ai-sdk/provider";
import type { FilesApi } from "@statewalker/webrun-files";
import { CompositeFilesApi, FilteredFilesApi } from "@statewalker/webrun-files-composite";
import type { ToolSet } from "ai";
import { ConfigManager } from "../config/config-manager.js";
import { SecretsManager } from "../config/secrets-manager.js";
import { type CompactOptions, ContextCompactor } from "../context/context-compactor.js";
import { createDefaultPinPolicy } from "../context/pin-policy.js";
import { selectHierarchical } from "../context/select-hierarchical.js";
import type { SelectionStrategy } from "../context/select-messages.js";
import { createTokenEstimator } from "../context/token-estimator.js";
import { createDefaultElisionPolicy } from "../context/tool-elision.js";
import { McpClientManager, type McpServerConfig } from "../mcp/mcp-client-manager.js";
import type { ModelManager } from "../models/model-manager.js";
import { UnifiedProvider } from "../models/unified-provider.js";
import { FilesSessionManager } from "../sessions/files-session-manager.js";
import type { SessionMetadata } from "../sessions/types.js";
import { parseSkillMarkdown } from "../skills/skill-parser.js";
import type { SkillInfo } from "../skills/skill-types.js";
import { Agent } from "./agent.js";
import { combineFilters, hideUnder } from "./files-split.js";
import { Session } from "./session.js";
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
  private _config?: ConfigManager;
  private _secrets?: SecretsManager;
  private _provider?: ProviderV3;
  private _modelManager?: ModelManager;
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
   * `ModelManager` instances are accepted as a convenience: the manager is
   * wrapped in a {@link UnifiedProvider} internally.
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

    // 1. Sanity-check the path geometry.
    if (this._systemPath === "/" && this._userPath === "/") {
      const err = new Error(
        "AgentRuntime: setSystemPath('/') with default userPath would hide every path from tools",
      );
      this._errorHandler(err, { path: "/" });
      throw err;
    }

    // 2. Build the two FilesApi views.
    //    System view is rooted at systemPath: a path like "/sessions" on
    //    systemFiles resolves to "<systemPath>/sessions" on rootFiles.
    this._systemFiles = new CompositeFilesApi(this._rootFiles, this._systemPath);

    //    Tools view: when userPath is "/", tools see the root with system
    //    folders hidden via FilteredFilesApi. When userPath is a subtree,
    //    tools see that subtree as their root via CompositeFilesApi —
    //    everything outside (including systemPath) is naturally invisible.
    if (this._userPath === "/") {
      const hidePaths = [this._systemPath];
      // Per-subject paths that may live OUTSIDE systemPath via overrides
      // also need to be hidden from tools.
      for (const p of [this._sessionsPath, this._skillsPath, this._agentsPath, this._configPath]) {
        if (p && !isUnderSystem(p, this._systemPath)) hidePaths.push(p);
      }
      this._toolsFiles = new FilteredFilesApi(
        this._rootFiles,
        combineFilters(...hidePaths.map(hideUnder)),
      );
    } else {
      this._toolsFiles = new CompositeFilesApi(this._rootFiles, this._userPath);
    }

    // 3. Config + Secrets — paths are relative to systemFiles' root.
    this._config = new ConfigManager(
      this._systemFiles,
      toSystemRelative(this._configPath, this._systemPath, "/"),
    );
    this._secrets = new SecretsManager(this._config);

    // 4. Resolve provider — first explicit ProviderV3 wins; else fall back
    //    to a UnifiedProvider over a registered ModelManager.
    const explicitProviders = this._providers.filter(isProviderV3);
    const modelManagers = this._providers.filter((p): p is ModelManager => !isProviderV3(p));
    if (explicitProviders.length > 0) {
      this._provider = explicitProviders[0];
      // TODO: union of multiple providers — for now first wins.
    } else if (modelManagers.length > 0) {
      const first = modelManagers[0];
      if (!first) throw new Error("unreachable");
      this._modelManager = first;
      this._provider = new UnifiedProvider(first.store);
    } else {
      const err = new Error("AgentRuntime: no model provider configured. Use .addModelProvider()");
      this._errorHandler(err);
      throw err;
    }

    // 5. Sessions storage — paths are relative to systemFiles' root.
    this._sessions = new FilesSessionManager(
      this._systemFiles,
      toSystemRelative(this._sessionsPath, this._systemPath, "/sessions"),
    );

    // 6. Resolve tools.
    const tools: ToolSet = {};
    for (const input of this._toolInputs) {
      const set = typeof input === "function" ? await input(this._buildAgentContext()) : input;
      Object.assign(tools, set);
    }
    this._resolvedTools = tools;

    // 7. Resolve skills (manual + folder) — relative to systemFiles' root.
    const skills: SkillInfo[] = [...this._skills];
    const skillsPath = toSystemRelative(this._skillsPath, this._systemPath, "/skills");
    if (await this._systemFiles.exists(skillsPath)) {
      for await (const entry of this._systemFiles.list(skillsPath)) {
        if (entry.kind !== "file" || !entry.name.endsWith(".md")) continue;
        try {
          const text = await readFile(this._systemFiles, entry.path);
          const skill = parseSkillMarkdown(text, entry.path);
          if (skill) skills.push(skill);
        } catch (err) {
          this._errorHandler(err as Error, { path: entry.path });
        }
      }
    }
    this._resolvedSkills = skills;

    // 8. MCP.
    if (this._mcpServers || this._mcpConfigFile) {
      this._mcp = new McpClientManager().setErrorHandler((e, c) =>
        this._errorHandler(e as Error, c as AgentRuntimeErrorContext),
      );
      let serverConfigs = this._mcpServers;
      if (this._mcpConfigFile) {
        try {
          const cfg = await this._config.load<{ servers: Record<string, McpServerConfig> }>(
            this._mcpConfigFile,
          );
          if (cfg?.servers) serverConfigs = { ...serverConfigs, ...cfg.servers };
        } catch (err) {
          this._errorHandler(err as Error, { path: this._mcpConfigFile });
        }
      }
      if (serverConfigs) {
        await this._mcp.loadServers(serverConfigs);
      }
    }

    // 9. Agent definitions from disk (optional) — relative to systemFiles.
    const agentsPath = toSystemRelative(this._agentsPath, this._systemPath, "/agents");
    if (await this._systemFiles.exists(agentsPath)) {
      for await (const entry of this._systemFiles.list(agentsPath)) {
        if (entry.kind !== "file" || !entry.name.endsWith(".md")) continue;
        try {
          const text = await readFile(this._systemFiles, entry.path);
          const def = parseAgentMarkdown(text, entry.name.replace(/\.md$/, ""));
          if (def && !this._agents.has(def.name)) {
            this._agents.set(def.name, new Agent(def, this));
          }
        } catch (err) {
          this._errorHandler(err as Error, { path: entry.path });
        }
      }
    }

    this._built = true;
    return this;
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

  /** Resume an existing session by id. */
  async loadSession(sessionId: string): Promise<Session> {
    this._assertBuilt();
    const tree = await this._requireSessions().load(sessionId);
    // Resumed sessions don't have a bound Agent definition unless the
    // caller threads one through. Use a synthetic "default" agent if no
    // matching one was registered. The caller can rebind via Session#bind
    // (not implemented here yet — TODO when it surfaces a real use case).
    const def: AgentDefinition = { name: "__resumed__" };
    const agent = new Agent(def, this);
    return new Session(agent, this, sessionId, tree);
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

  get models(): ModelManager | undefined {
    return this._modelManager;
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

  /** @internal */
  get budgetCompactionOptions():
    | {
        select: SelectionStrategy;
        compactor: ContextCompactor;
        compactOptions: Omit<CompactOptions, "eventSink">;
      }
    | undefined {
    if (!this._budgetCompaction) return undefined;
    const bc = this._budgetCompaction;
    const estimator = bc.estimator ?? createTokenEstimator();
    const pinPolicy = bc.pinPolicy ?? createDefaultPinPolicy();
    const elisionPolicy = bc.elisionPolicy ?? createDefaultElisionPolicy();
    const keepRecentTurns = bc.keepRecentTurns ?? 4;
    return {
      select: selectHierarchical({
        budgetTokens: bc.budgetTokens,
        keepRecentTurns,
        pinPolicy,
        elisionPolicy,
        estimator,
      }),
      compactor: new ContextCompactor(),
      compactOptions: {
        budgetTokens: bc.budgetTokens,
        summarizer: bc.summarizer,
        estimator,
        pinPolicy,
        elisionPolicy,
        keepRecentTurns,
        groupSize: bc.groupSize,
        depthPromoteThreshold: bc.depthPromoteThreshold,
        maxPassesPerCompact: bc.maxPassesPerCompact,
      } satisfies Omit<CompactOptions, "eventSink">,
    };
  }

  /** @internal */
  get errorHandler(): AgentRuntimeErrorHandler {
    return this._errorHandler;
  }

  /** @internal */
  saveSession(sessionId: string, tree: import("../state/session.js").Session): Promise<void> {
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
      modelManager: this._modelManager,
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function isProviderV3(p: ModelProviderInput): p is ProviderV3 {
  return typeof (p as ProviderV3).languageModel === "function";
}

function normalizeFolderPath(path: string): string {
  let p = path.startsWith("/") ? path : `/${path}`;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

/**
 * `true` if `subPath` is the same as `systemPath` or lives under it.
 * Used to decide whether a per-subject override needs to be hidden from
 * the tools view (overrides outside systemPath are reachable via the
 * root and must be filtered out explicitly).
 */
function isUnderSystem(subPath: string, systemPath: string): boolean {
  if (subPath === systemPath) return true;
  return subPath.startsWith(`${systemPath}/`);
}

/**
 * Translate an absolute per-subject path into a path relative to
 * systemFiles' root (which is `systemPath` after the `CompositeFilesApi`
 * rebase). If the override lives outside `systemPath`, return it
 * unchanged — system code passes it to the *underlying* `rootFiles` via
 * the system view (which delegates outside the rebase to the same
 * backend, just through the composite's mount logic).
 *
 * `defaultRelative` is used when the override is undefined.
 */
function toSystemRelative(
  override: string | undefined,
  systemPath: string,
  defaultRelative: string,
): string {
  if (override === undefined) return defaultRelative;
  if (override === systemPath) return "/";
  if (override.startsWith(`${systemPath}/`)) {
    return override.slice(systemPath.length);
  }
  return override;
}

async function readFile(files: FilesApi, path: string): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of files.read(path)) chunks.push(chunk);
  const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/**
 * Parse an Agent definition file (markdown with key=value frontmatter
 * delimited by `---` lines). Falls back to no definition if the file is
 * not recognizable as such — the caller treats `null` as "skip".
 */
function parseAgentMarkdown(text: string, fallbackName: string): AgentDefinition | null {
  // Reuse the skill markdown layout (frontmatter parser + body) but the
  // shape is intentionally similar — both are key/value config files.
  const parsed = parseSkillMarkdown(text, fallbackName);
  if (!parsed) return null;
  const def: AgentDefinition = { name: parsed.name ?? fallbackName };
  if (parsed.description) def.systemPrompt = parsed.content ?? parsed.description;
  return def;
}
