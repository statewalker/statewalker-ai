// One Workspace DO per workspace: the store (from the deployment's configuration), the role sources (each project's access file and the
// workspace's SQL, as the deployment's ROLE_SOURCES var chains them), the
// workspace's root key (it never leaves this DO), and the gate every file call of every agent
// session goes through. Its name is the workspace. It mints a user capability for a user session
// that a User DO opens with the user's access token, and the gate reads user, project and session
// from each call's capability: it never calls a User DO (statewalker/statewalker-root#157).

import { DurableObject } from "cloudflare:workers";
import {
  type AgentSessionFacts,
  type ApprovalGrant,
  ApprovalRegistry,
  type ApprovalRequest,
  type AutoSettings,
  accessOf,
  approvalId,
  chainRoleSources,
  classifierPrompt,
  classifierTranscript,
  codedError,
  codeOf,
  DEFAULT_MODE,
  DEFAULT_SYSTEM_FOLDER,
  DenialCounter,
  decide,
  decideAuto,
  decideMode,
  type FileAction,
  fileRoleSource,
  isMode,
  type ModeDefinition,
  type ModeRequest,
  matchRules,
  modeOf,
  PERMISSION_RULES_FILE,
  type PermissionRules,
  parseAutoMode,
  parseClassifierAnswer,
  parseRules,
  REMOTE_AGENT_PREFIX,
  type ResolvedMode,
  type RoleEntries,
  type RoleGrant,
  type RoleSource,
  type RuleLayer,
  remoteAgentRequest,
  resolveRoles,
  SqlRoleSource,
  type StoredRootKey,
  settleAsk,
  type ToolGrant,
  toolRequest,
  WORKSPACE_ROLES,
  WorkspaceAuthority,
} from "@statewalker/ai-access";
import {
  type AgentDefinition,
  type Allow,
  buildPlugin,
  catalogMcpServers,
  catalogToolDefinitions,
  catalogTools,
  definitionsView,
  findAgent,
  type McpServer,
  matches,
  mcpAnswer,
  mcpCallOutput,
  mcpRequest,
  mcpTools,
  type NarrowedAgent,
  narrowAgent,
  type Plugin,
  readPlugins,
  restRequest,
  TOOL_EXTENSION,
  type ToolDefinition,
  type ToolExtension,
} from "@statewalker/ai-definitions";
import {
  approvalError,
  approvalOf,
  type CatalogModel,
  type ClassifiedVerdict,
  checkModelsConfig,
  checkUserProvider,
  deploymentSecrets,
  discoverModels,
  estimateRequest,
  FilesRpcHost,
  type FilesRpcMethod,
  filesOverRpc,
  type GateDecision,
  type GatedFilesOptions,
  type GatewayResult,
  gatedFiles,
  gatedFilesRpc,
  gatewayFetch,
  IGNORE_FILE,
  ignoreRules,
  type Limit,
  lookupModel,
  type ModeGate,
  type ModelCall,
  type ModelCatalog,
  ModelGateway,
  type ModelLevel,
  type ModelMeter,
  type ModelRequestMeta,
  type ModelResponse,
  type ModelRight,
  type ModelsConfig,
  type ModeVerdict,
  mayUse,
  normalise,
  type OutgoingRequest,
  parseModelsConfig,
  pickSessionModel,
  redactSecrets,
  resolveModels,
  resolveSecrets,
  rootedFiles,
  type SecretInfo,
  SecretStore,
  type StoredLevel,
  sessionSecrets,
  withDelay,
} from "@statewalker/ai-environment";
import {
  DELETED_USER,
  KeyedLock,
  type MemoryCall,
  type MemoryKind,
  MemoryService,
  memoryCall,
  memoryFiles,
  memoryRef,
  parseMemoryCaps,
  projectName,
  runMemoryCall,
  scanText,
  type Writer,
  writes,
} from "@statewalker/ai-memory";
import type {
  AgentRun,
  CreatedServiceAccount,
  DeleteSecretRequest,
  ModelsQuery,
  ModelView,
  PinnedDefinitions,
  SecretScope,
  SecretView,
  ServiceAccountView,
  SetSecretRequest,
} from "@statewalker/ai-sessions";
import {
  foldUhpServers,
  isTerminal,
  isUhpId,
  parseRemoteAgentId,
  parseUhpServers,
  remoteAgentId,
  remoteAgents,
  UHP_PLUGIN,
  UHP_VERSION,
  type UhpAnswer,
  type UhpCall,
  type UhpServer,
  uhpError,
} from "@statewalker/ai-uhp-client";
import { type FilesApi, tryReadText, writeText } from "@statewalker/webrun-files";
import { CompositeFilesApi } from "@statewalker/webrun-files-composite";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { isBrowserHosting, localSecretsKey } from "./browser.js";
import { type DatabaseCall, DatabaseGate, type DatabaseView } from "./database-gate.js";
import { databaseOf } from "./db-tools.js";
import { agentRun, DefinitionsStore, type PluginLevel } from "./definitions-store.js";
import {
  agentOf,
  blockSizeOf,
  deploymentModes,
  deploymentRules,
  type Env,
  issuerOf,
  nameOf,
  verifyToken,
} from "./env.js";
import {
  meteredFiles,
  refusal,
  type WarningView,
  WorkspaceLimits,
  warningView,
} from "./limits-host.js";
import { ModelStore, type ModelUsageRecord } from "./model-store.js";
import { toolEsbuild } from "./tool-bundler.js";
import { describeBundle, runBundle, ToolHost } from "./tool-executor.js";
import { mountWorkspace } from "./workspace-store.js";

/** How strict a verdict is: of two, the stricter one wins ("classify" may still deny). */
const STRICTNESS = { allow: 0, classify: 1, ask: 2, deny: 3 } as const;

/** The project's instructions for agents, which auto mode's risk classifier is shown. */
const AGENTS_FILE = "AGENTS.md";
/** How long a remote MCP server's tool list is kept at most, and after a failure (#135). */
const MCP_LIST_TTL_MS = 5 * 60_000;
const MCP_LIST_FAILURE_MS = 10_000;
/** The most `tools/list` pages read from one server. */
const MCP_LIST_PAGES = 16;

/** The definitions mount's folder in each project of an agent session's file view. */
const DEFINITIONS_FOLDER = ".agents";

/** The most a native tool reads of a file at once, and lists of a folder. */
const MAX_TOOL_READ = 16 * 1024 * 1024;
const MAX_TOOL_LIST = 10_000;

/** The workspace's and each project's model configuration, in their system folders. */
const MODELS_FILE = "models";
/** A project's memory caps, beside its system folder's other settings (#157). */
const MEMORY_CAPS_FILE = "memory-caps";
/** The workspace's own UHP servers, in its system folder (#144). */
const UHP_SERVERS_FILE = "uhp-servers";
/** The most bytes of one answer from a UHP server, unless UHP_WRITEBACK_MAX_BYTES says otherwise. */
const DEFAULT_WRITEBACK_MAX = 16 * 1024 * 1024;
/** Where a project's memory lives in its system folder (#157). */
const MEMORY_FOLDER = "memory";

export class Workspace extends DurableObject<Env> {
  readonly #name: string;
  readonly #store: Promise<FilesApi>;
  /** One files-RPC server per capability that holds a file view, so streams live across calls. */
  readonly #files: FilesRpcHost;
  readonly #authority: WorkspaceAuthority;
  readonly #sqlRoles: SqlRoleSource;
  readonly #roles: RoleSource;
  readonly #registry: ApprovalRegistry;
  /** Auto mode's risk classifier: the deployment's settings, and each session's denials. */
  readonly #auto: AutoSettings;
  readonly #denials: DenialCounter;
  readonly #modes: Record<string, ModeDefinition>;
  readonly #deploymentRules: PermissionRules;
  readonly #secrets: SecretStore;
  /** Whether this deployment runs in a browser page (HOSTING "browser"). */
  readonly #browser: boolean;
  readonly #definitions: DefinitionsStore;
  readonly #models: ModelStore;
  readonly #databases: DatabaseGate;
  /** The workspace's, its projects' and its members' limits and counters (#179). */
  readonly #limits: WorkspaceLimits;
  /** Writes to each project's and agent's memory are serialized (statewalker/statewalker-root#157). */
  readonly #memoryLock = new KeyedLock();
  /** The deployment's model configuration, read once from the MODELS var. */
  #deploymentModels?: ModelsConfig;
  /** The deployment catalog's plugins, read once from the CATALOG var. */
  #deploymentPlugins?: Promise<{ plugins: Plugin[]; problems: string[] }>;
  /** UHP servers' harnesses as discovered (#144), by server: listed name or id → harness id. */
  readonly #harnesses = new Map<string, { at: number; ids: Map<string, string> }>();
  /** Plugin builds by level and source hash (statewalker/statewalker-root#130). */
  readonly #builds = new Map<string, Promise<{ plugin?: Plugin; problems: string[] }>>();
  /**
   * The tools remote MCP servers listed, by session and server, while their answer's time to live
   * lasts (statewalker/statewalker-root#135): listing is a request through the gateway.
   */
  readonly #mcpLists = new Map<string, { until: number; tools: Promise<ToolDefinition[]> }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#name = nameOf(ctx);
    const sql = ctx.storage.sql;
    this.#store = mountWorkspace(env, ctx.storage, this.#name);
    this.#store.catch(() => {});
    this.#files = new FilesRpcHost((capability) => this.#fileView(capability));
    sql.exec("CREATE TABLE IF NOT EXISTS ws_keys (name TEXT PRIMARY KEY, value TEXT NOT NULL)");
    // The tracer kept user and agent sessions here; they live in User DOs now. No release held
    // them, so their rows are dropped rather than migrated.
    sql.exec("DROP TABLE IF EXISTS user_sessions");
    sql.exec("DROP TABLE IF EXISTS agent_sessions");
    const stored = sql.exec("SELECT value FROM ws_keys WHERE name = 'root'").toArray()[0];
    let root: StoredRootKey;
    if (stored) root = JSON.parse(String(stored.value));
    else {
      root = WorkspaceAuthority.generate();
      sql.exec("INSERT INTO ws_keys VALUES ('root', ?)", JSON.stringify(root));
    }
    // The revocation list (statewalker/statewalker-root#78, #127): the revocation ids of revoked
    // capabilities' blocks. A capability holding one is refused at its next use, everywhere the
    // authority verifies it: the gate, every block of a stream, secrets and the gateway.
    sql.exec(
      "CREATE TABLE IF NOT EXISTS revocations (id TEXT PRIMARY KEY, revoked INTEGER NOT NULL)",
    );
    this.#authority = WorkspaceAuthority.fromStored(root, {
      isRevoked: (ids) =>
        ids.length > 0 &&
        sql
          .exec(
            `SELECT 1 FROM revocations WHERE id IN (${ids.map(() => "?").join(", ")}) LIMIT 1`,
            ...ids,
          )
          .toArray().length > 0,
    });
    this.#sqlRoles = new SqlRoleSource(sql);
    this.#limits = new WorkspaceLimits(sql, env, this.#name, async (path) =>
      tryReadText(await this.#store, path),
    );
    const files = fileRoleSource(
      async (path) => tryReadText(await this.#store, path),
      DEFAULT_SYSTEM_FOLDER,
    );
    const sources: RoleSource[] = [];
    for (const name of (env.ROLE_SOURCES || "file").split(",").map((s) => s.trim())) {
      if (name === "file") sources.push(files);
      else if (name === "sql") sources.push(this.#sqlRoles);
      else if (name) throw codedError("EIO", `unknown role source '${name}'`);
    }
    this.#roles = chainRoleSources(sources);
    this.#registry = new ApprovalRegistry(sql);
    const auto = parseAutoMode(env.AUTO_MODE);
    if (auto.problems.length) console.warn(`AUTO_MODE: ${auto.problems.join("; ")}`);
    this.#auto = auto.settings;
    this.#denials = new DenialCounter(sql);
    this.#modes = deploymentModes(env);
    this.#deploymentRules = deploymentRules(env);
    // Workspace, project and user secrets: sealed rows in this DO's SQLite, never files.
    // In a browser page the deployment holds no key: its users' secrets are sealed with one the
    // page made for itself, and SECRETS_KEY is ignored even when given.
    this.#browser = isBrowserHosting(env);
    this.#secrets = new SecretStore({
      sql,
      secretsKey: this.#browser ? localSecretsKey(sql) : env.SECRETS_KEY,
      workspace: this.#name,
    });
    this.#definitions = new DefinitionsStore(sql);
    this.#models = new ModelStore(sql);
    this.#databases = new DatabaseGate({
      sql,
      workspace: this.#name,
      authority: this.#authority,
      store: this.#store,
      systemFolder: DEFAULT_SYSTEM_FOLDER,
      backend: (name) => env.DATABASE.get(env.DATABASE.idFromName(name)),
      access: (project, user) => this.#access(project, user),
      decide: async (facts, req) => {
        const decide = await this.#decider(facts, await this.#store);
        return this.#settled(decide(req.area, req.action, req.target), facts);
      },
      consume: async (facts, id) => this.#registry.consume(id, facts.session, facts.user),
      classify: async (facts, request) => this.#classify(facts, await this.#store, request),
      record: (facts, decision) => this.#record(facts, decision),
      mayCallTool: (facts, tool) => this.#mayCallTool(facts, tool),
      // A write over a storage limit fails with ENOSPC; queries still run (#179).
      admitWrite: async (project) =>
        this.#limits.admitStorage(project, 1, await this.#store, () => this.#databases.storage()),
    });
  }

  /**
   * The user capability for the user session of the access token's user, which must be for this
   * workspace: signed here, so the root key stays here.
   */
  async userCapability(token: string): Promise<string> {
    const claims = await verifyToken(this.env, token);
    if (claims.workspace !== this.#name)
      throw codedError("EAUTH", "the access token is for another workspace");
    return this.#authority.mintUser(claims.user);
  }

  /**
   * The roles in a project of the user a user capability names, from the role sources now;
   * EACCES for a non-member (membership gives visibility).
   */
  async memberRoles(capability: string, project: string): Promise<string[]> {
    const user = await this.#authority.userOf(capability);
    const access = await this.#access(project, user);
    if (!access.member) throw codedError("EACCES", `${user} is not a member of ${project}`);
    return access.grants.map((g) => g.role);
  }

  async #access(project: string, user: string) {
    const access = await accessOf(this.#roles, project, user);
    // Unknown roles, permissions and cycles are reported here and grant nothing.
    if (access.problems.length)
      console.warn(`roles of ${user} in ${project}: ${access.problems.join("; ")}`);
    return access;
  }

  /** Whether a user sees a project: membership, from the role sources now. */
  async #member(project: string, user: string): Promise<boolean> {
    try {
      return (await this.#access(project, user)).member;
    } catch {
      return false;
    }
  }

  /** The user's `<area>.use` permissions in a project, as the definitions ask for them. */
  #allow(grants: readonly RoleGrant[]): Allow {
    // A read tool may also be used with `tools.read` (readers, statewalker/statewalker-root#129).
    // A remote agent only with `agents.use:remote:<server>/<harness>` (#144).
    return (area, target, action) =>
      area === "agents" && target.startsWith(REMOTE_AGENT_PREFIX)
        ? decide(grants, remoteAgentRequest(target.slice(REMOTE_AGENT_PREFIX.length)))
        : decide(grants, { area, action: "use", target }) ||
          (area === "tools" &&
            action === "read" &&
            decide(grants, { area, action: "read", target }));
  }

  #readDeploymentPlugins() {
    this.#deploymentPlugins ??= (async () => {
      const sources = new MemFilesApi();
      const files = this.env.CATALOG
        ? (JSON.parse(this.env.CATALOG) as Record<string, string>)
        : {};
      for (const [path, text] of Object.entries(files))
        await writeText(sources, normalise(path), text);
      return readPlugins(sources, "/");
    })();
    return this.#deploymentPlugins;
  }

  /**
   * The plugins of the three levels for a project: the deployment's catalog, the workspace's
   * system folder and the project's `.system/plugins/`. A name taken at a broader level stays
   * that level's: a project can't replace a deployment or workspace plugin.
   */
  async #plugins(project: string): Promise<(Plugin & { level: PluginLevel })[]> {
    const store = await this.#store;
    const levels: [PluginLevel, { plugins: Plugin[]; problems: string[] }][] = [
      ["deployment", await this.#readDeploymentPlugins()],
      ["workspace", await readPlugins(store, `/${DEFAULT_SYSTEM_FOLDER}/plugins`)],
      ["project", await readPlugins(store, `/${project}/${DEFAULT_SYSTEM_FOLDER}/plugins`)],
    ];
    const plugins: (Plugin & { level: PluginLevel })[] = [];
    const problems: string[] = [];
    for (const [level, read] of levels) {
      problems.push(...read.problems);
      for (const source of read.plugins) {
        if (plugins.some((q) => q.name === source.name)) {
          problems.push(`${source.name}: already loaded at a broader level; skipped`);
          continue;
        }
        const built = await this.#build(source, level);
        problems.push(...built.problems);
        if (built.plugin) plugins.push({ ...built.plugin, level });
      }
    }
    if (problems.length) console.warn(`plugins of ${project}: ${problems.join("; ")}`);
    return plugins;
  }

  /**
   * A plugin's native tools built into its bundle (statewalker/statewalker-root#130): bundled by
   * webrun-bundler, OpenCode-style tools described in an isolate, and workspace and project
   * plugins held to the acceptance check. Kept by level and source hash while this DO lives.
   */
  #build(plugin: Plugin, level: PluginLevel): Promise<{ plugin?: Plugin; problems: string[] }> {
    const key = `${level}:${plugin.hash}`;
    let built = this.#builds.get(key);
    if (!built) {
      const loader = this.env.LOADER;
      built = buildPlugin(plugin, {
        esbuild: toolEsbuild,
        accept: level !== "deployment",
        ...(loader ? { describe: (code: string) => describeBundle(loader, code) } : {}),
      });
      this.#builds.set(key, built);
      built.catch(() => this.#builds.delete(key));
      if (this.#builds.size > 256) this.#builds.delete(this.#builds.keys().next().value as string);
    }
    return built;
  }

  /**
   * Pins the definitions of a new agent session (statewalker/statewalker-root#82, #128): the
   * plugins of the three levels, kept by content hash, and the agent, picked and narrowed now. The
   * agent asked for must be one the user may use (ENOENT otherwise, as for any absent thing);
   * without one, the project's default (`.system/settings` `{"agent": ...}`) applies, then the
   * deployment's, then the generic agent. Only a User DO calls this, with a user capability.
   */
  async pinDefinitions(
    capability: string,
    req: { session: string; project: string; agent?: string; model?: string },
  ): Promise<PinnedDefinitions> {
    const user = await this.#authority.userOfUserCapability(capability);
    const project = String(req.project);
    const access = await this.#access(project, user);
    if (!access.member) throw codedError("EACCES", `${user} is not a member of ${project}`);
    const plugins = await this.#plugins(project);
    const catalog = await this.#definitions.catalogOf(plugins);
    const allow = this.#allow(access.grants);
    // Remote agents (#144): the harnesses the UHP servers list here, each `remote:<server>/<harness>`.
    const servers = await this.#uhpServers();
    const remotes: string[] = [];
    for (const id of remoteAgents(servers)) if (await allow("agents", id)) remotes.push(id);
    const usable = async (id: string | undefined) => {
      if (!id) return undefined;
      const ref = parseRemoteAgentId(id);
      const agent: AgentDefinition | undefined = ref
        ? remotes.includes(id)
          ? {
              id,
              plugin: "remote",
              name: ref.harness,
              models: [],
              tools: [],
              agents: [],
              instructions: "",
              remote: ref,
            }
          : undefined
        : await findAgent(catalog, id);
      if (!agent || !(await allow("agents", agent.id))) return undefined;
      // A plugin agent whose core is remote needs that remote agent too.
      if (
        agent.remote &&
        !remotes.includes(remoteAgentId(agent.remote.server, agent.remote.harness))
      )
        return undefined;
      return agent;
    };
    let agent = await usable(req.agent);
    if (req.agent && !agent) throw codedError("ENOENT", `no agent '${req.agent}' here`);
    if (!agent) {
      const settings = await tryReadText(
        await this.#store,
        `/${project}/${DEFAULT_SYSTEM_FOLDER}/settings`,
      );
      let projectDefault: string | undefined;
      try {
        const agentName = settings ? JSON.parse(settings)?.agent : undefined;
        projectDefault = typeof agentName === "string" ? agentName : undefined;
      } catch {
        console.warn(`settings of ${project} are not JSON`);
      }
      agent = (await usable(projectDefault)) ?? (await usable(this.env.DEFAULT_AGENT));
    }
    const run: NarrowedAgent | undefined = agent
      ? await narrowAgent(catalog, agent, allow, remotes)
      : undefined;
    // The session's model, pinned with its fallbacks and the catalog it was picked from
    // (statewalker/statewalker-root#105): nothing fits, nothing is pinned and no session starts.
    const models = await pickSessionModel(await this.#modelCatalog(project, user), {
      ...(req.model !== undefined ? { override: String(req.model) } : {}),
      agentModels: agent?.models ?? [],
      right: this.#modelRight(access.grants),
    });
    // An active session counts against the limits on sessions (429 over them, #179).
    await this.#limits.startSession(project, user, String(req.session));
    this.#models.pin(String(req.session), user, project, models);
    for (const p of plugins) this.#definitions.keep(p);
    this.#definitions.pin(
      String(req.session),
      user,
      project,
      plugins.map((p) => ({ name: p.name, hash: p.hash, level: p.level })),
      run,
    );
    const limits = await this.#limits.sessionLimits(project);
    const ownKeys = [models.model, ...models.fallbacks].some((id) => {
      const m = lookupModel(models.catalog, id);
      return m && models.catalog.providers[m.provider]?.level === "user";
    });
    return {
      ...(run ? { agent: run.id, run: agentRun(run) } : { agent: "default" }),
      model: models.model,
      plugins: plugins.map((p) => p.name),
      ...(limits.length ? { limits } : {}),
      ...(ownKeys ? { ownKeys: true } : {}),
    };
  }

  /**
   * Pins a fork's definitions (statewalker/statewalker-root#190): the agent and plugin bundles the
   * source session pinned, unchanged, and its models, or `model` picked afresh within the user's
   * rights now. The user must still be a member of the project; the source must be theirs (ENOENT
   * otherwise). The fork counts as an active session. Only a User DO calls this, with a user
   * capability.
   */
  async forkDefinitions(
    capability: string,
    req: { from: string; session: string; model?: string },
  ): Promise<PinnedDefinitions> {
    const user = await this.#authority.userOfUserCapability(capability);
    const source = this.#definitions.pins(String(req.from));
    const models = this.#models.pinned(String(req.from));
    if (!source || !models || source.user !== user || models.user !== user)
      throw codedError("ENOENT", "no such agent session");
    const project = source.project;
    const access = await this.#access(project, user);
    if (!access.member) throw codedError("EACCES", `${user} is not a member of ${project}`);
    const run = source.run;
    const pinned =
      req.model !== undefined
        ? await pickSessionModel(await this.#modelCatalog(project, user), {
            override: String(req.model),
            agentModels: run?.models ?? [],
            right: this.#modelRight(access.grants),
          })
        : models.pinned;
    await this.#limits.startSession(project, user, String(req.session));
    this.#models.pin(String(req.session), user, project, pinned);
    this.#definitions.pin(String(req.session), user, project, source.pins, run);
    const limits = await this.#limits.sessionLimits(project);
    const ownKeys = [pinned.model, ...pinned.fallbacks].some((id) => {
      const m = lookupModel(pinned.catalog, id);
      return m && pinned.catalog.providers[m.provider]?.level === "user";
    });
    return {
      ...(run ? { agent: run.id, run: agentRun(run) } : { agent: "default" }),
      model: pinned.model,
      plugins: source.pins.map((p) => p.name),
      ...(limits.length ? { limits } : {}),
      ...(ownKeys ? { ownKeys: true } : {}),
    };
  }

  // --- the model gateway (statewalker/statewalker-root#105, #134) ------------------------------

  #readDeploymentModels(): ModelsConfig {
    if (!this.#deploymentModels) {
      const { config, problems } = parseModelsConfig(this.env.MODELS);
      if (problems.length) console.warn(`MODELS: ${problems.join("; ")}`);
      this.#deploymentModels = config;
    }
    return this.#deploymentModels;
  }

  /** Hosts a user-level provider may use over http or at a private address (test-only). */
  #userProviderHosts(): string[] {
    return (this.env.USER_PROVIDER_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
  }

  /** The user's own level, with any provider at an address a user may not use left out. */
  #userModels(user: string): ModelsConfig {
    const config = this.#models.userConfig(user) ?? {};
    const providers = (config.providers ?? []).filter((p) => {
      try {
        checkUserProvider(p, this.#userProviderHosts());
        return true;
      } catch {
        return false;
      }
    });
    return { ...config, providers };
  }

  /** The four levels folded for a user in a project: what its sessions may be served. */
  async #modelCatalog(project: string, user: string): Promise<ModelCatalog> {
    const store = await this.#store;
    const read = async (path: string, level: ModelLevel) => {
      const { config, problems } = parseModelsConfig(await tryReadText(store, path));
      if (problems.length) console.warn(`models of the ${level} (${path}): ${problems.join("; ")}`);
      return config;
    };
    const { catalog, problems } = resolveModels([
      { level: "deployment", config: this.#readDeploymentModels() },
      {
        level: "workspace",
        config: await read(`/${DEFAULT_SYSTEM_FOLDER}/${MODELS_FILE}`, "workspace"),
      },
      {
        level: "project",
        config: await read(`/${project}/${DEFAULT_SYSTEM_FOLDER}/${MODELS_FILE}`, "project"),
      },
      { level: "user", config: this.#userModels(user) },
    ]);
    if (problems.length) console.warn(`models of ${project}: ${problems.join("; ")}`);
    return catalog;
  }

  /** `models.use:<provider>/<model>` or `models.use:<alias>`, decided from the grants. */
  #modelRight(grants: readonly RoleGrant[]): ModelRight {
    return (target) => decide(grants, { area: "models", action: "use", target });
  }

  /**
   * One model request of an agent session, through the gateway: the session's pinned models,
   * the user's model rights now, the provider's key from the session's secrets (bound to the
   * `model-gateway` plugin and the provider's host), and the request metered in the workspace's
   * budget. The key never leaves this DO except in the request to the provider.
   */
  async modelRequest(
    capability: string,
    call: ModelCall & { turn?: string },
  ): Promise<ModelResponse> {
    const facts = await this.#authority.agentSessionOf(capability);
    const access = await this.#access(facts.project, facts.user);
    if (!access.member)
      throw codedError("EACCES", `${facts.user} is not a member of ${facts.project}`);
    const found = this.#models.pinned(facts.session);
    if (!found || found.user !== facts.user || found.project !== facts.project)
      throw codedError("ENOENT", "the agent session pinned no model");
    const turn =
      typeof call.turn === "string" && call.turn.startsWith(`${facts.session}.tu-`)
        ? call.turn
        : undefined;
    const gateway = new ModelGateway({
      secrets: sessionSecrets(this.#secrets, this.#deploymentSecrets(), facts),
      // The budget records every request; limits reserve its worst case in `admit` and settle it
      // in `record` (#179).
      meter: this.#modelMeter(facts.project, facts.user),
    });
    return gateway.request(
      found.pinned,
      {
        context: call.context,
        ...(typeof call.model === "string" && call.model ? { model: call.model } : {}),
        ...(typeof call.maxTokens === "number" ? { maxTokens: call.maxTokens } : {}),
      },
      this.#modelRight(access.grants),
      {
        session: facts.session,
        ...(turn ? { turn } : {}),
        user: facts.user,
        project: facts.project,
      },
    );
  }

  /**
   * The worst case of an agent session's next model request (statewalker/statewalker-root#179),
   * over every model it may run on (the one asked for, the session's and its fallbacks): what the
   * session reserves against its own limits, and, for the user's own keys, against the user's.
   */
  async modelEstimate(
    capability: string,
    call: ModelCall,
  ): Promise<{ worst: Record<string, number>; own?: Record<string, number> }> {
    const facts = await this.#authority.agentSessionOf(capability);
    const found = this.#models.pinned(facts.session);
    if (!found || found.user !== facts.user || found.project !== facts.project)
      throw codedError("ENOENT", "the agent session pinned no model");
    const { catalog } = found.pinned;
    const ids = [
      ...(typeof call.model === "string" && call.model ? [call.model] : []),
      found.pinned.model,
      ...found.pinned.fallbacks,
    ];
    const worst: Record<string, number> = { model_tokens: 0 };
    let own: Record<string, number> | undefined;
    for (const id of ids) {
      const model = lookupModel(catalog, id);
      const provider = model ? catalog.providers[model.provider] : undefined;
      if (!model || !provider) continue;
      const e = estimateRequest(model, provider, {
        context: call.context,
        ...(typeof call.maxTokens === "number" ? { maxTokens: call.maxTokens } : {}),
      });
      const amounts = { model_tokens: e.input_tokens + e.max_tokens, model_spend: e.cost ?? 0 };
      if (e.own_key) own ??= { model_tokens: 0 };
      for (const into of e.own_key && own ? [worst, own] : [worst])
        for (const [k, v] of Object.entries(amounts)) into[k] = Math.max(into[k] ?? 0, v);
    }
    return { worst, ...(own ? { own } : {}) };
  }

  /**
   * The workspace's side of model spend (statewalker/statewalker-root#179): the worst case of each
   * request is reserved against the workspace (and the deployment's ceilings), the project and the
   * member before the model is asked, and settled to the real cost after. The user's own key is
   * charged to the user (their User DO), not here.
   */
  #modelMeter(project: string, user: string): ModelMeter {
    return {
      admit: async (_model, meta, estimate) => {
        if (estimate.own_key) return undefined;
        const scopes = await this.#limits.scopes(project, user);
        const amounts = {
          model_tokens: estimate.input_tokens + estimate.max_tokens,
          ...(estimate.cost ? { model_spend: estimate.cost } : {}),
        };
        try {
          return await withDelay(() =>
            this.#limits.ledger.reserve(scopes, amounts, this.#modelUsageMeta(meta)),
          );
        } catch (e) {
          throw refusal(e);
        }
      },
      record: (usage, meta, admitted) => {
        this.#models.record(usage, meta);
        const id = (admitted as { id?: string } | undefined)?.id;
        if (!id) return [];
        return this.#limits.ledger
          .settle(
            id,
            {
              model_tokens: usage.input_tokens + usage.output_tokens,
              ...(usage.cost ? { model_spend: usage.cost } : {}),
            },
            this.#modelUsageMeta(meta),
            {
              model: usage.model,
              input_tokens: usage.input_tokens,
              output_tokens: usage.output_tokens,
              cached_tokens: usage.cached_tokens,
              outcome: usage.outcome,
            },
          )
          .map(warningView);
      },
    };
  }

  #modelUsageMeta(meta: ModelRequestMeta) {
    return this.#limits.meta(meta.project, meta.user, meta.session, meta.turn);
  }

  /**
   * A project's models as a member sees them: every configured one, whether they may use it, and,
   * with `discover`, the models each provider's `/models` lists that no level configured (off).
   */
  async listModels(userCapability: string, query: ModelsQuery): Promise<ModelView[]> {
    const user = await this.#authority.userOfUserCapability(userCapability);
    const project = String(query.project);
    const access = await this.#access(project, user);
    if (!access.member) throw codedError("EACCES", `${user} is not a member of ${project}`);
    const catalog = await this.#modelCatalog(project, user);
    const right = this.#modelRight(access.grants);
    const views: ModelView[] = [];
    const view = async (m: CatalogModel): Promise<ModelView> => ({
      id: m.id,
      aliases: [...m.aliases].sort(),
      provider: m.provider,
      level: m.level,
      enabled: true,
      allowed: await mayUse(m, right),
    });
    for (const m of Object.values(catalog.models)) views.push(await view(m));
    if (query.discover) {
      const secrets = sessionSecrets(this.#secrets, this.#deploymentSecrets(), { project, user });
      for (const provider of Object.values(catalog.providers)) {
        let names: string[] = [];
        try {
          names = await discoverModels(provider, secrets);
        } catch (e) {
          console.warn(`discovery of ${provider.id}: ${String((e as Error)?.message ?? e)}`);
        }
        for (const name of names) {
          const id = `${provider.id}/${name}`;
          if (views.some((v) => v.id === id)) continue;
          views.push({
            id,
            aliases: [],
            provider: provider.id,
            level: provider.level,
            enabled: false,
            allowed: await right(id),
            discovered: true,
          });
        }
      }
    }
    return views.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** The user's own model configuration (user level) in this workspace. */
  async getModelConfig(userCapability: string): Promise<ModelsConfig> {
    const user = await this.#authority.userOfUserCapability(userCapability);
    return this.#models.userConfig(user) ?? {};
  }

  /**
   * Replaces the user's own model configuration: providers (keys are the user's secrets, bound to
   * `model-gateway` and the provider's host) at https addresses that are not private.
   */
  async setModelConfig(userCapability: string, config: unknown): Promise<ModelsConfig> {
    const user = await this.#authority.userOfUserCapability(userCapability);
    const checked = checkModelsConfig(config);
    for (const p of checked.providers ?? []) checkUserProvider(p, this.#userProviderHosts());
    this.#models.setUserConfig(user, checked);
    return checked;
  }

  /** Test-only: every model request the workspace's budget recorded. */
  async modelUsage(): Promise<ModelUsageRecord[]> {
    return this.#models.usage();
  }

  /**
   * The store as an agent session sees it: its pinned definitions, filtered by the user's
   * permissions at every call, mounted read-only at `<project>/.agents/` over the project.
   */
  async #withDefinitions(
    store: FilesApi,
    agent: { session: string; user: string; project: string },
  ): Promise<FilesApi> {
    const mount = `/${agent.project}/${DEFINITIONS_FOLDER}`;
    const found = await this.#definitions.session(agent.session);
    const pinned = found && found.user === agent.user && found.project === agent.project;
    // A session without pins (started before definitions existed) sees an empty mount.
    if (!pinned)
      return new CompositeFilesApi(store).mount(
        mount,
        await definitionsView(new MemFilesApi(), { allow: () => false }),
      );
    // Roles are read again at most every quarter second: one listing asks for every entry.
    let cached: { at: number; grants: Promise<readonly RoleGrant[]> } | undefined;
    const grants = () => {
      if (!cached || Date.now() - cached.at > 250) {
        const read = this.#access(agent.project, agent.user).then((a) =>
          a.member ? a.grants : [],
        );
        cached = { at: Date.now(), grants: read };
        read.catch(() => {
          cached = undefined;
        });
      }
      return cached.grants;
    };
    const view = await definitionsView(found.catalog, {
      allow: async (area, target, action) => this.#allow(await grants())(area, target, action),
      ...(found.run ? { agent: found.run } : {}),
    });
    return new CompositeFilesApi(store).mount(mount, view);
  }

  /**
   * The gated view a capability holds, as a files-RPC endpoint. An agent session's capability sees
   * its project, with the ignore rules applied; the user capability of a user session sees every
   * project the user is a member of, without them. Membership and roles are read from the role
   * sources at every action, never fixed when the view opens, so a demotion or removal reaches the
   * next call and the next block of a stream.
   * For an agent session, every operation is then decided by the permission rules of the
   * deployment, the project, the user and the agent session, and the user session's current mode
   * (statewalker/statewalker-root#124), read from the registry at every call: a mode switch reaches
   * the next action of a running session. A change the mode asks about waits on an approval,
   * unless the user granted that exact action.
   */
  async #fileView(capability: string) {
    const { store, options, agent } = await this.#gatedOptions(capability);
    return gatedFilesRpc(store, options, agent ? this.#modeGate(agent, store) : undefined);
  }

  /** The store and options of the gated view a capability holds (before the mode). */
  async #gatedOptions(capability: string) {
    const raw = this.#meteredStore(await this.#store);
    const agent = await this.#authority.agentSessionOf(capability).catch(() => undefined);
    const user = agent?.user ?? (await this.#authority.userOfUserCapability(capability));
    const store = agent ? await this.#withDefinitions(raw, agent) : raw;
    // Many actions at once (a folder's entries): the roles read once per project, the capability
    // verified once (statewalker-ai#49).
    const authorizeAll = async (checks: readonly [FileAction, string][]) => {
      const byProject = new Map<string, { action: FileAction; path: string }[]>();
      for (const [action, path] of checks) {
        // An agent session acts in its project only; the user's own session in the path's.
        const project = agent?.project ?? path.split("/")[1] ?? "";
        if (!project) throw codedError("EACCES", `may not ${action} '${path}'`);
        const list = byProject.get(project) ?? [];
        list.push({ action, path });
        byProject.set(project, list);
      }
      for (const [project, list] of byProject) {
        const { grants } = await this.#access(project, user);
        await this.#authority.authorizeMany(capability, { project, grants, checks: list });
      }
    };
    const options: GatedFilesOptions = {
      systemFolder: DEFAULT_SYSTEM_FOLDER,
      blockSize: blockSizeOf(this.env),
      visible: (project) => this.#member(project, user),
      authorize: (action, path) => authorizeAll([[action, path]]),
      authorizeAll,
      ...(agent
        ? {
            ignoreRules: async (project: string) =>
              ignoreRules([
                this.env.IGNORE,
                await tryReadText(store, `/${project}/${DEFAULT_SYSTEM_FOLDER}/${IGNORE_FILE}`),
              ]),
          }
        : {}),
    };
    return { store, options, agent };
  }

  /**
   * The store as file views write to it: every change counts against the storage limits of the
   * project it lands in, and fails with ENOSPC over one (statewalker/statewalker-root#179).
   */
  #meteredStore(store: FilesApi): FilesApi {
    return meteredFiles(store, {
      ensure: (project) => this.#limits.ensureStorage(project, store),
      admit: (project, delta) =>
        this.#limits.admitStorage(project, delta, store, () => this.#databases.storage()),
      adjust: (project, delta) => this.#limits.adjustStorage(project, "", delta, store),
    });
  }

  /**
   * The gate: one files-RPC call on the file view a capability holds (an agent session's, or a
   * user session's own), decided now. User, project and session come from the capability itself;
   * a capability this workspace did not sign is refused (EACCES).
   */
  async files(capability: string, method: FilesRpcMethod, args: unknown[]): Promise<unknown> {
    return this.#files.call(capability, method, args);
  }

  /**
   * How the rules of the deployment, the project, the user and the agent session, and the user
   * session's current mode, decide the actions of one agent session: read once (per operation),
   * then decided per action, for files and databases alike. In a classifier mode (`auto`,
   * statewalker/statewalker-root#137) the rules come first (broad allow rules set aside), then the
   * safe classes; what they leave is "classify", for the risk classifier. After too many
   * classifier denials the session falls back to `default` for good. Verdicts carry their step
   * (and so become items) while the session runs a classifier mode, or fell back from one. Asks
   * are not settled here (unattended sessions): the caller settles them.
   */
  async #decider(
    facts: AgentSessionFacts,
    store: FilesApi,
  ): Promise<(area: string, action: string, target: string) => ModeVerdict> {
    const auto = this.#auto;
    const { mode, extra, layers, recorded } = await this.#modeState(facts, store);
    const decideIn = (m: ResolvedMode, req: ModeRequest): ModeVerdict => {
      if (m.classifier) {
        const d = decideAuto(req, { mode: m, layers, protectedPaths: auto.protectedPaths });
        return d.step === "classifier"
          ? { verdict: "classify", reason: d.reason, step: "classifier" }
          : { verdict: d.verdict, reason: d.reason, step: d.step };
      }
      const d = decideMode(req, { mode: m, layers });
      return { verdict: d.verdict, reason: d.reason, step: d.source === "mode" ? "mode" : "rule" };
    };
    return (area, action, target) => {
      const req = { area, action, target };
      let decision = decideIn(mode, req);
      for (const m of extra) {
        const other: ModeVerdict = m
          ? decideIn(m, req)
          : { verdict: "deny", reason: "an unknown sub-agent mode", step: "mode" };
        if (STRICTNESS[other.verdict] > STRICTNESS[decision.verdict]) decision = other;
      }
      if (!recorded) {
        const { step: _step, ...plain } = decision;
        return plain;
      }
      return decision;
    };
  }

  /** An unattended session has nobody to ask: its asks are denies with a reason (#127). */
  #settled(decision: ModeVerdict, facts: AgentSessionFacts): ModeVerdict {
    return decision.verdict === "classify"
      ? decision
      : (settleAsk(
          decision as ModeVerdict & { verdict: "allow" | "ask" | "deny" },
          facts,
        ) as ModeVerdict);
  }

  /** Keeps one decision of `auto` as an item of the agent session. */
  async #record(facts: AgentSessionFacts, decision: GateDecision): Promise<void> {
    try {
      await agentOf(this.env, facts.session).gateDecision(decision);
    } catch (e) {
      // The decision stands; only its item is missing.
      console.warn(`decision item of ${facts.session}: ${String((e as Error)?.message ?? e)}`);
    }
  }

  /**
   * What decides one agent session's actions now: the user session's mode (a classifier mode the
   * session fell back from is `default`), a sub-agent's own modes, and the rules of the deployment,
   * the project, the user and the session; `recorded` while decisions become items (a classifier
   * mode, or one fallen back from).
   */
  async #modeState(facts: AgentSessionFacts, store: FilesApi) {
    const root = `/${facts.project}`;
    const state = this.#registry.userSession(facts.user);
    const fallen = this.#denials.fallenBack(facts.session);
    const effective = (m: ResolvedMode) =>
      m.classifier && fallen ? modeOf(DEFAULT_MODE, this.#modes) : m;
    const name = state && isMode(state.mode, this.#modes) ? state.mode : DEFAULT_MODE;
    const mode = effective(modeOf(name, this.#modes));
    const projectRules = parseRules(
      await tryReadText(store, `${root}/${DEFAULT_SYSTEM_FOLDER}/${PERMISSION_RULES_FILE}`),
    );
    const layers: RuleLayer[] = [
      { source: "deployment", rules: this.#deploymentRules },
      { source: "project", rules: projectRules },
      { source: "user", rules: state?.rules ?? {} },
      this.#registry.sessionLayer(facts.session, facts.user),
    ];
    // A sub-agent's own modes (statewalker/statewalker-root#126) decide beside the user session's,
    // and the strictest verdict wins: a child is never looser than its parent. A mode the
    // deployment no longer knows denies.
    const extra = (facts.modes ?? []).map((m) =>
      isMode(m, this.#modes) ? effective(modeOf(m, this.#modes)) : undefined,
    );
    const recorded = !!mode.classifier || (fallen && name !== DEFAULT_MODE);
    return { mode, extra, layers, recorded };
  }

  /**
   * The mode and the rules of one agent session, as the files gate decides them at every call,
   * every decision on a change kept as an item of the session in a classifier mode.
   */
  #modeGate(facts: AgentSessionFacts, store: FilesApi): ModeGate {
    return {
      session: facts.session,
      project: facts.project,
      decide: async (checks) => {
        const root = `/${facts.project}`;
        // Read once per operation: the user session's mode and rules, and the project's rules.
        const decideOne = await this.#decider(facts, store);
        const definitions = `${root}/${DEFINITIONS_FOLDER}`.toLowerCase();
        return checks.map(([action, path]): ModeVerdict => {
          // Outside the project nothing is decided here: the roles and the capability refuse it.
          if (path !== root && !path.startsWith(`${root}/`))
            return { verdict: "allow", reason: "outside the project" };
          // The definitions mount is read-only in every mode: no change there ever asks.
          if (
            action !== "read" &&
            action !== "list" &&
            (path.toLowerCase() === definitions || path.toLowerCase().startsWith(`${definitions}/`))
          )
            return { verdict: "deny", reason: "the definitions mount is read-only" };
          const decision = decideOne(
            "files",
            action,
            path === root ? "/" : path.slice(root.length),
          );
          // An unattended session's asks are denies with a reason, and the agent carries on.
          return this.#settled(decision, facts);
        });
      },
      consume: async (id) => this.#registry.consume(id, facts.session, facts.user),
      classify: (request) => this.#classify(facts, store, request),
      record: (decision) => this.#record(facts, decision),
    };
  }

  /**
   * Auto mode's risk classifier on one change (statewalker/statewalker-root#96): the deployment's
   * model, through the model gateway within the user's model rights and metered in the workspace's
   * budget (not a turn's), shown the user's messages, the agent's non-read tool calls, the pending
   * action, the agent's instructions and the project's AGENTS.md, never tool results or file
   * contents. A missing model, an error, a slow answer (AUTO_MODE timeout) or an unparseable one is
   * a deny. Its denials are counted: too many and the session falls back to `default`.
   */
  async #classify(
    facts: AgentSessionFacts,
    store: FilesApi,
    request: ApprovalRequest,
  ): Promise<ClassifiedVerdict> {
    const auto = this.#auto;
    const started = Date.now();
    const answer = await (async (): Promise<{
      verdict: "allow" | "ask" | "deny";
      reason: string;
      model?: string;
    }> => {
      if (!auto.model) return { verdict: "deny", reason: "no risk classifier model is configured" };
      const deny = (why: string) => ({
        verdict: "deny" as const,
        reason: `the risk classifier ${why}`,
        model: auto.model,
      });
      try {
        const access = await this.#access(facts.project, facts.user);
        const found = this.#models.pinned(facts.session);
        if (!access.member || !found || found.user !== facts.user)
          return deny("cannot run for this session");
        const items = await agentOf(this.env, facts.session).classifierItems();
        const definitions = await this.#definitions.session(facts.session);
        const agentsMd = await tryReadText(store, `/${facts.project}/${AGENTS_FILE}`);
        const prompt = classifierPrompt({
          transcript: classifierTranscript(items),
          action: { ...request.action, permission: request.permission },
          ...(definitions?.run?.instructions ? { instructions: definitions.run.instructions } : {}),
          ...(agentsMd ? { agentsMd } : {}),
        });
        const gateway = new ModelGateway({
          secrets: sessionSecrets(this.#secrets, this.#deploymentSecrets(), facts),
          // The classifier spends the workspace's budget like any request (#179).
          meter: this.#modelMeter(facts.project, facts.user),
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<"timeout">((ok) => {
          timer = setTimeout(() => ok("timeout"), auto.timeoutMs);
        });
        const asked = gateway.request(
          // The deployment's model alone: no substitution, no fallback to the agent's models.
          { catalog: found.pinned.catalog, model: auto.model as string, fallbacks: [] },
          {
            // pi-ai's normalized context: the system prompt as its leading message.
            context: {
              messages: [
                { role: "system", content: prompt.system, timestamp: 0 },
                { role: "user", content: prompt.user, timestamp: Date.now() },
              ],
            },
            maxTokens: auto.maxTokens,
          },
          this.#modelRight(access.grants),
          { session: facts.session, user: facts.user, project: facts.project },
        );
        asked.catch(() => {});
        const response = await Promise.race([asked, timeout]).finally(() => clearTimeout(timer));
        if (response === "timeout") return deny(`did not answer within ${auto.timeoutMs} ms`);
        const reply = response.message;
        const model = response.attempts.at(-1)?.usage.model ?? response.model;
        if (reply.stopReason === "error" || reply.stopReason === "aborted")
          return { ...deny(`failed: ${reply.errorMessage ?? reply.stopReason}`), model };
        const text = (reply.content as { type?: string; text?: string }[])
          .filter((p) => p.type === "text")
          .map((p) => p.text ?? "")
          .join("");
        const parsed = parseClassifierAnswer(text);
        if (!parsed) return { ...deny("gave an unparseable answer"), model };
        return {
          verdict: parsed.verdict,
          reason: parsed.reason || `the risk classifier says ${parsed.verdict}`,
          model,
        };
      } catch (e) {
        return deny(`failed: ${String((e as Error)?.message ?? e)}`);
      }
    })();
    const latency_ms = Date.now() - started;
    const fell = this.#denials.count(facts.session, answer.verdict, auto);
    // An unattended session's ask is a deny (statewalker/statewalker-root#127).
    const settled = settleAsk(answer, facts);
    return {
      verdict: settled.verdict,
      reason: settled.reason,
      ...(answer.model ? { model: answer.model } : {}),
      latency_ms,
      ...(fell ? { fallback: DEFAULT_MODE } : {}),
      ...(fell && facts.unattended
        ? {
            stop: `auto mode fell back to ${DEFAULT_MODE} after too many denials; the session is unattended, so its turn stops`,
          }
        : {}),
    };
  }

  // --- databases (statewalker/statewalker-root#81, #136) --------------------------------------

  /**
   * One db-rpc call on a project's database, for the holder of a capability (an agent session, a
   * plugin tool of one, or the user's own session), decided at the gate now.
   */
  async databaseCall(capability: string, call: DatabaseCall): Promise<unknown> {
    return this.#databases.call(capability, call);
  }

  /** Creates or drops a project's database (`db.admin`; for an agent, under the mode). */
  async manageDatabase(
    capability: string,
    req: { project?: string; database: string; op: "create" | "drop" },
  ) {
    return this.#databases.manage(capability, req);
  }

  /** A project's declared databases the holder may use. */
  async listDatabases(capability: string, project?: string): Promise<DatabaseView[]> {
    return this.#databases.list(capability, project);
  }

  /** Whether an agent session may call one plugin tool now: pinned at its start, and `tools.call`. */
  async #mayCallTool(facts: AgentSessionFacts, tool: ToolGrant): Promise<boolean> {
    const found = await this.#definitions.session(facts.session);
    if (!found || found.user !== facts.user || found.project !== facts.project) return false;
    const id = `${tool.plugin}/${tool.tool}`;
    if (!(await catalogTools(found.catalog)).some((t) => t.id === id)) return false;
    // An agent whose definition lists its tools gets only those.
    if (found.run?.tools?.length && !found.run.tools.includes(id)) return false;
    const access = await this.#access(facts.project, facts.user);
    return access.member && decide(access.grants, { area: "tools", action: "call", target: id });
  }

  /**
   * The capability one plugin tool of an agent session runs with: the session's, narrowed by a
   * block this workspace signs, so the tool reaches the plugin's private databases (and nothing
   * the session can't). Only for a tool the session may call now; the agent never holds it.
   */
  async forTool(agentCapability: string, tool: ToolGrant): Promise<string> {
    const facts = await this.#authority.agentSessionOf(agentCapability);
    if (!(await this.#mayCallTool(facts, tool)))
      throw codedError("EACCES", `may not call ${String(tool?.plugin)}/${String(tool?.tool)}`);
    return this.#authority.forTool(agentCapability, tool);
  }

  // --- remote agent sessions (statewalker/statewalker-root#109, #144) --------------------------

  /** The UHP servers this workspace may use: the deployment's, then the workspace's own. */
  async #uhpServers(): Promise<UhpServer[]> {
    const deployment = parseUhpServers(this.env.UHP_SERVERS, "deployment");
    const workspace = parseUhpServers(
      await tryReadText(await this.#store, `/${DEFAULT_SYSTEM_FOLDER}/${UHP_SERVERS_FILE}`),
      "workspace",
    );
    for (const [where, read] of [
      ["UHP_SERVERS", deployment],
      [`/${DEFAULT_SYSTEM_FOLDER}/${UHP_SERVERS_FILE}`, workspace],
    ] as const)
      if (read.problems.length) console.warn(`${where}: ${read.problems.join("; ")}`);
    return foldUhpServers([deployment.servers, workspace.servers]);
  }

  #uhpTables() {
    const sql = this.ctx.storage.sql;
    // The remote tasks running now, with the revocation ids of the capability that started each:
    // a revocation of any of them cancels the task.
    sql.exec(`CREATE TABLE IF NOT EXISTS uhp_active (response TEXT NOT NULL, server TEXT NOT NULL,
      session TEXT NOT NULL, project TEXT NOT NULL, user TEXT NOT NULL, revocations TEXT NOT NULL,
      PRIMARY KEY (server, response))`);
    // Sessions whose start (an open-world run action) was decided: later tasks are continuations.
    sql.exec("CREATE TABLE IF NOT EXISTS uhp_started (session TEXT PRIMARY KEY)");
    return sql;
  }

  /**
   * One request to a UHP server for an agent session: its token is the secret the server names,
   * put in by the gateway only when bound to plugin `uhp` and the server's host; counted against
   * the workspace's, project's and member's limits on outbound requests and bytes. A refusal before
   * sending is `refused`, never retried.
   */
  async #uhpSend(
    facts: { session: string; project: string; user: string },
    server: UhpServer,
    method: string,
    path: string,
    options: {
      body?: unknown;
      headers?: Record<string, string>;
      binary?: boolean;
      turn?: string;
    } = {},
  ): Promise<{
    status: number;
    json?: unknown;
    bytes?: Uint8Array;
    error?: string;
    refused?: boolean;
  }> {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const request: OutgoingRequest = {
      method,
      url: `${server.baseUrl}${path}`,
      headers: {
        authorization: `Bearer {{secret:${server.secret}}}`,
        "uhp-version": UHP_VERSION,
        accept: options.binary ? "*/*" : "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(options.headers ?? {}),
      },
      ...(body !== undefined ? { body } : {}),
    };
    const lookup = sessionSecrets(this.#secrets, this.#deploymentSecrets(), facts);
    const resolved = await resolveSecrets(request, UHP_PLUGIN, lookup);
    if (!resolved.ok) return { status: 0, error: resolved.error, refused: true };
    const meta = this.#limits.meta(facts.project, facts.user, facts.session, options.turn);
    const detail = { plugin: UHP_PLUGIN, host: new URL(request.url).host };
    await this.#limits.charge(
      facts.project,
      facts.user,
      { outbound_requests: 1, outbound_bytes: new TextEncoder().encode(body ?? "").length },
      meta,
      detail,
    );
    let res: Response;
    try {
      res = await fetch(resolved.url, {
        method,
        headers: resolved.headers,
        ...(body !== undefined ? { body } : {}),
        redirect: "manual",
      });
    } catch (e) {
      return {
        status: 0,
        error: `EIO: the UHP server could not be reached: ${redactSecrets(String((e as Error)?.message ?? e), resolved.used)}`,
      };
    }
    const max = Number(this.env.UHP_WRITEBACK_MAX_BYTES) || DEFAULT_WRITEBACK_MAX;
    const bytes = new Uint8Array(await res.arrayBuffer());
    this.#limits.ledger.add(
      await this.#limits.scopes(facts.project, facts.user),
      { outbound_bytes: bytes.length },
      meta,
      detail,
    );
    if (bytes.length > max)
      return { status: 0, error: "EIO: the UHP server's answer is too large", refused: true };
    if (options.binary && res.ok) return { status: res.status, bytes };
    const text = redactSecrets(new TextDecoder().decode(bytes), resolved.used);
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, ...(json !== undefined ? { json } : {}) };
  }

  /** The UHP harness id a listed harness names, as the server reports it now (cached briefly). */
  async #uhpHarness(
    facts: { session: string; project: string; user: string },
    server: UhpServer,
    listed: string,
  ): Promise<string> {
    const key = `${server.id} ${server.baseUrl}`;
    const cached = this.#harnesses.get(key);
    let ids = cached && Date.now() - cached.at < 5 * 60_000 ? cached.ids : undefined;
    if (!ids) {
      const got = await this.#uhpSend(facts, server, "GET", "/v1/harnesses");
      if (got.refused || got.status === 0) throw new Error(got.error ?? "EIO: discovery failed");
      if (got.status !== 200) throw uhpError(got.status, got.json, "the harness discovery");
      const list = ((got.json as { harnesses?: { id?: unknown; name?: unknown }[] })?.harnesses ??
        []) as { id?: unknown; name?: unknown }[];
      ids = new Map();
      for (const h of list)
        if (typeof h?.id === "string") {
          ids.set(h.id, h.id);
          if (typeof h.name === "string" && !ids.has(h.name)) ids.set(h.name, h.id);
        }
      this.#harnesses.set(key, { at: Date.now(), ids });
    }
    const id = ids.get(listed);
    if (!id)
      throw codedError("ENOENT", `the UHP server ${server.id} offers no harness '${listed}'`);
    return id;
  }

  /**
   * Decides starting a remote agent session's task, once per session: an open-world `run` action
   * (`agents.use:remote:<server>/<harness>` in the rules) that asks in `default`, goes to the risk
   * classifier in `auto` and is allowed in `bypassPermissions`; an unattended session's ask is a
   * deny. Throws the approval it waits on, or the refusal.
   */
  async #decideRemoteStart(facts: AgentSessionFacts, target: string): Promise<void> {
    const sql = this.#uhpTables();
    if (sql.exec("SELECT 1 FROM uhp_started WHERE session = ?", facts.session).toArray().length)
      return;
    const store = await this.#store;
    const verdict = this.#settled(
      (await this.#decider(facts, store))("agents", "remote", target),
      facts,
    );
    const request: ApprovalRequest = {
      id: await approvalId(facts.session, "remote", target),
      session: facts.session,
      project: facts.project,
      action: { method: "remote", path: target },
      permission: `agents.use:remote:${target}`,
      reason: `starting the remote agent remote:${target} sends it copies of the project's files: ${verdict.reason}`,
    };
    const record = async (d: Omit<GateDecision, "action">) => {
      if (verdict.step) await this.#record(facts, { action: request.action, ...d });
    };
    if (verdict.verdict === "deny")
      throw codedError("EACCES", `may not start remote:${target}: ${verdict.reason}`);
    if (verdict.verdict !== "allow") {
      if (this.#registry.consume(request.id, facts.session, facts.user))
        await record({
          step: "approval",
          verdict: "allow",
          reason: "the user approved this action",
        });
      else if (verdict.verdict === "classify") {
        const c = await this.#classify(facts, store, request);
        await record({
          step: "classifier",
          verdict: c.verdict,
          reason: c.reason,
          ...(c.model ? { model: c.model } : {}),
          latency_ms: c.latency_ms,
          ...(c.fallback ? { fallback: c.fallback } : {}),
          ...(c.stop ? { stop: c.stop } : {}),
        });
        if (c.verdict === "deny")
          throw codedError(
            "EACCES",
            `may not start remote:${target}: the risk classifier denied it: ${c.reason}`,
          );
        if (c.verdict === "ask") throw approvalError({ ...request, reason: c.reason });
      } else {
        await record({ step: verdict.step ?? "mode", verdict: "ask", reason: verdict.reason });
        throw approvalError(request);
      }
    }
    sql.exec("INSERT OR IGNORE INTO uhp_started VALUES (?)", facts.session);
  }

  /**
   * One call of a remote agent session to its UHP server (statewalker/statewalker-root#144), for
   * the holder of its capability: the server and harness are the session's pinned ones, used now
   * only while the user's roles still grant `agents.use:remote:<server>/<harness>`. A task's body
   * carries its input and continuation only: never a tool, an MCP server or a secret of ours. The
   * first task's start is decided under the mode (#decideRemoteStart).
   */
  async uhp(agentCapability: string, call: UhpCall & { turn?: string }): Promise<UhpAnswer> {
    const facts = await this.#authority.agentSessionOf(agentCapability);
    const found = await this.#definitions.session(facts.session);
    const remote = found?.run?.remote;
    if (!found || found.user !== facts.user || found.project !== facts.project || !remote)
      throw codedError("EACCES", "not a remote agent session");
    const server = (await this.#uhpServers()).find((s) => s.id === remote.server);
    const listed = server?.harnesses[remote.harness];
    if (!server || !listed)
      throw codedError("ENOENT", `no remote agent remote:${remote.server}/${remote.harness} here`);
    const target = `${remote.server}/${remote.harness}`;
    const access = await this.#access(facts.project, facts.user);
    if (!access.member || !decide(access.grants, remoteAgentRequest(target)))
      throw codedError("EACCES", `may not use remote:${target}`);
    const turn = this.#turnOf(facts.session, call.turn);
    const sql = this.#uhpTables();
    const done = (response: string) =>
      sql.exec("DELETE FROM uhp_active WHERE server = ? AND response = ?", server.id, response);
    const answer = (got: UhpAnswer & { refused?: boolean }): UhpAnswer => {
      if (got.refused) throw new Error(got.error);
      const { refused: _r, ...rest } = got;
      return rest;
    };
    switch (call.op) {
      case "respond": {
        await this.#decideRemoteStart(facts, target);
        const harness = await this.#uhpHarness(facts, server, listed);
        const b = (call.body ?? {}) as Record<string, unknown>;
        const body = {
          input: b.input,
          ...(isUhpId(b.previous_response_id)
            ? { previous_response_id: b.previous_response_id }
            : {}),
          background: true,
          store: true,
          metadata: { harness_id: harness },
        };
        const key = String(call.idempotencyKey ?? "");
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(key))
          throw codedError("EINVAL", "a task needs an idempotency key");
        const got = answer(
          await this.#uhpSend(facts, server, "POST", "/v1/responses", {
            body,
            headers: { "idempotency-key": key },
            ...(turn ? { turn } : {}),
          }),
        );
        const id = (got.json as { id?: unknown })?.id;
        if (got.status >= 200 && got.status < 300 && isUhpId(id))
          sql.exec(
            "INSERT OR REPLACE INTO uhp_active VALUES (?, ?, ?, ?, ?, ?)",
            id,
            server.id,
            facts.session,
            facts.project,
            facts.user,
            JSON.stringify(await this.#authority.revocationIdsOf(agentCapability)),
          );
        return got;
      }
      case "get": {
        if (!isUhpId(call.response)) throw codedError("EINVAL", "no such response");
        const got = answer(
          await this.#uhpSend(facts, server, "GET", `/v1/responses/${call.response}`, {
            ...(turn ? { turn } : {}),
          }),
        );
        const status = (got.json as { status?: unknown })?.status;
        if (typeof status === "string" && isTerminal(status)) done(call.response);
        return got;
      }
      case "cancel": {
        if (!isUhpId(call.response)) throw codedError("EINVAL", "no such response");
        done(call.response);
        return answer(
          await this.#uhpSend(facts, server, "POST", `/v1/responses/${call.response}/cancel`),
        );
      }
      case "download": {
        if (!isUhpId(call.container) || !isUhpId(call.file))
          throw codedError("EINVAL", "no such file");
        return answer(
          await this.#uhpSend(
            facts,
            server,
            "GET",
            `/v1/containers/${call.container}/files/${call.file}/content`,
            { binary: true, ...(turn ? { turn } : {}) },
          ),
        );
      }
      default:
        throw codedError("EINVAL", "no such UHP call");
    }
  }

  /** Sends UHP cancel to every remote task a revoked block stopped. */
  async #cancelRemote(revoked: string): Promise<void> {
    const sql = this.#uhpTables();
    const rows = sql.exec("SELECT * FROM uhp_active").toArray() as unknown as {
      response: string;
      server: string;
      session: string;
      project: string;
      user: string;
      revocations: string;
    }[];
    const servers = rows.length ? await this.#uhpServers() : [];
    for (const row of rows) {
      if (!(JSON.parse(String(row.revocations)) as string[]).includes(revoked)) continue;
      sql.exec(
        "DELETE FROM uhp_active WHERE server = ? AND response = ?",
        row.server,
        row.response,
      );
      const server = servers.find((s) => s.id === row.server);
      if (!server) continue;
      try {
        await this.#uhpSend(row, server, "POST", `/v1/responses/${row.response}/cancel`);
      } catch (e) {
        console.warn(`UHP cancel of ${row.response}: ${String((e as Error)?.message ?? e)}`);
      }
    }
  }

  /**
   * Writes a remote agent session's returned artifacts back through its capability, as one change
   * set (statewalker/statewalker-root#109): one `write` under the mode for all the files, so in
   * `default` the user is asked once, with the files listed; each write is then authorized again
   * by the capability and the roles. A denial of any file refuses the whole set; an approval the
   * user granted for exactly these files is consumed.
   */
  async applyChangeSet(
    agentCapability: string,
    req: { files: { path: string; content: Uint8Array }[] },
  ): Promise<{ written: string[] }> {
    const facts = await this.#authority.agentSessionOf(agentCapability);
    const found = await this.#definitions.session(facts.session);
    if (!found?.run?.remote || found.user !== facts.user)
      throw codedError("EACCES", "not a remote agent session");
    const root = `/${facts.project}`;
    const files = (Array.isArray(req?.files) ? req.files : []).map((f) => ({
      path: normalise(String(f?.path)),
      content: f?.content instanceof Uint8Array ? f.content : new Uint8Array(),
    }));
    if (!files.length) throw codedError("EINVAL", "an empty change set");
    for (const f of files)
      if (!f.path.startsWith(`${root}/`))
        throw codedError("EACCES", `may not write back '${f.path}': outside the project`);
    const store = await this.#store;
    const gate = this.#modeGate(facts, store);
    const verdicts = await gate.decide(files.map((f) => ["write", f.path] as [FileAction, string]));
    const denied = verdicts.flatMap((v, i) =>
      v.verdict === "deny" ? [`${files[i]?.path}: ${v.reason}`] : [],
    );
    if (denied.length) throw codedError("EACCES", `may not write back: ${denied.join("; ")}`);
    const worst = verdicts.reduce((a, b) =>
      STRICTNESS[b.verdict] > STRICTNESS[a.verdict] ? b : a,
    );
    if (worst.verdict !== "allow") {
      const enc = new TextEncoder();
      const listing: [string, string][] = [];
      for (const f of files)
        listing.push([
          f.path,
          [...new Uint8Array(await crypto.subtle.digest("SHA-256", f.content))]
            .map((b) => b.toString(16).padStart(2, "0"))
            .join(""),
        ]);
      const id = await approvalId(
        facts.session,
        "changeset",
        root,
        enc.encode(JSON.stringify(listing)),
      );
      const size = files.reduce((n, f) => n + f.content.length, 0);
      const paths = files.map((f) => f.path).join(", ");
      const request: ApprovalRequest = {
        id,
        session: facts.session,
        project: facts.project,
        action: { method: "changeset", path: root, size },
        permission: `files.write:${(files[0] as { path: string }).path.slice(root.length)}`,
        reason: `${found.run.id} returned ${files.length} file(s) to write back: ${paths}; ${worst.reason}`,
      };
      const record = async (d: Omit<GateDecision, "action">) => {
        if (worst.step) await this.#record(facts, { action: request.action, ...d });
      };
      if (this.#registry.consume(id, facts.session, facts.user))
        await record({
          step: "approval",
          verdict: "allow",
          reason: "the user approved this action",
        });
      else if (worst.verdict === "classify") {
        const c = await this.#classify(facts, store, request);
        await record({
          step: "classifier",
          verdict: c.verdict,
          reason: c.reason,
          ...(c.model ? { model: c.model } : {}),
          latency_ms: c.latency_ms,
          ...(c.fallback ? { fallback: c.fallback } : {}),
          ...(c.stop ? { stop: c.stop } : {}),
        });
        if (c.verdict === "deny")
          throw codedError(
            "EACCES",
            `may not write back: the risk classifier denied it: ${c.reason}`,
          );
        if (c.verdict === "ask") throw approvalError({ ...request, reason: c.reason });
      } else {
        await record({ step: worst.step ?? "mode", verdict: "ask", reason: worst.reason });
        throw approvalError(request);
      }
    }
    // Each write authorized again by the capability and the roles, in the agent's own view.
    const { store: view, options } = await this.#gatedOptions(agentCapability);
    const files$ = gatedFiles(view, options);
    for (const f of files) await files$.write(f.path, [f.content]);
    return { written: files.map((f) => f.path) };
  }

  // --- limits (statewalker/statewalker-root#179) -----------------------------------------------

  /**
   * Charges one of an agent session's flow meters (turns, tool calls, executor time) to its
   * workspace, project and member, at once: ELIMIT when a limit refuses. The warnings crossed are
   * answered, for the session's items and events.
   */
  async chargeUsage(
    capability: string,
    call: { meter: string; amount: number; turn?: string; detail?: Record<string, unknown> },
  ): Promise<WarningView[]> {
    const facts = await this.#authority.agentSessionOf(capability);
    const amount = Number(call.amount);
    if (!["turns", "tool_calls"].includes(call.meter) && !/^executor_cpu_ms(:|$)/.test(call.meter))
      throw codedError("EINVAL", `an agent session does not charge ${call.meter}`);
    if (!(amount > 0)) return [];
    const turn = this.#turnOf(facts.session, call.turn);
    const warnings = await this.#limits.charge(
      facts.project,
      facts.user,
      { [call.meter]: amount },
      this.#limits.meta(facts.project, facts.user, facts.session, turn),
      call.detail,
    );
    return warnings.map(warningView);
  }

  /** A turn id of the session's own, or none. */
  #turnOf(session: string, turn: unknown): string | undefined {
    return typeof turn === "string" && turn.startsWith(`${session}.tu-`) ? turn : undefined;
  }

  /** Holds one of a user's streams (an SSE stream, a long poll): ELIMIT (429) over a limit. */
  async holdStream(userCapability: string, id: string): Promise<void> {
    const user = await this.#authority.userOfUserCapability(userCapability);
    await this.#limits.holdStream(user, String(id));
  }

  /** Releases one of the user's streams. */
  async releaseStream(userCapability: string, id: string): Promise<void> {
    const user = await this.#authority.userOfUserCapability(userCapability);
    await this.#limits.releaseStream(user, String(id));
  }

  /**
   * An agent session of this user ended (archived, revoked or deleted), told by their User DO
   * with the user capability: it stops counting against the limits on sessions.
   */
  async sessionsEnded(userCapability: string, sessions: string[]): Promise<void> {
    const user = await this.#authority.userOfUserCapability(userCapability);
    for (const session of Array.isArray(sessions) ? sessions.map(String) : []) {
      const pinned = this.#models.pinned(session);
      if (pinned && pinned.user === user) await this.#limits.endSession(session);
    }
  }

  /**
   * Raises a member limit that asked by one increment, once the user approved it: the approval
   * the user granted at this gate (their User DO pushed it) is consumed, so a raise happens only
   * with the user's answer, and once (statewalker/statewalker-root#179).
   */
  async raiseLimit(
    capability: string,
    raise: { approval: string; key: string; increment: number },
  ): Promise<void> {
    const facts = await this.#authority.agentSessionOf(capability);
    let ref: unknown[];
    try {
      ref = JSON.parse(String(raise.key)) as unknown[];
    } catch {
      throw codedError("EINVAL", "no such limit");
    }
    if (ref[0] !== "member" || ref[1] !== facts.user)
      throw codedError("EACCES", "only the session's own member limit is raised here");
    if (!this.#registry.consume(String(raise.approval), facts.session, facts.user))
      throw codedError("EACCES", "the user did not approve raising this limit");
    // The increment is the limit's own (what it says now), never the caller's word.
    const limit = (await this.#limits.scopes(facts.project, facts.user))
      .find((s) => s.level === "member")
      ?.limits.find((l) => l.meter === ref[2] && l.period === ref[3]);
    if (!limit) throw codedError("ENOENT", "no such limit");
    this.#limits.ledger.raise(String(raise.key), limit.increment ?? (limit.value || 1));
  }

  /** Test-only: the workspace's usage records after a seq. */
  async usageRecords(since = 0) {
    return this.#limits.ledger.records(Number(since) || 0);
  }

  // --- tools (statewalker/statewalker-root#90, #129) -------------------------------------------

  /**
   * Every tool of an agent session now, with the verdict a call would get: the plugin tools its
   * pinned agent requested that the user's role grants now (`tools.use`, or `tools.read` for a read
   * tool), then the mode (a read tool is a read, any other a change); and the harness's own tools
   * the session names, decided only by `tool:` rules (their effects are decided at their own
   * gates). Tools the mode denies are left out; asking ones stay, and ask per call.
   */
  async #toolSet(
    facts: AgentSessionFacts,
    harness: readonly string[],
  ): Promise<{ name: string; verdict: ModeVerdict; definition?: ToolDefinition }[]> {
    const access = await this.#access(facts.project, facts.user);
    if (!access.member)
      throw codedError("EACCES", `${facts.user} is not a member of ${facts.project}`);
    const store = await this.#store;
    const { mode, extra, layers, recorded } = await this.#modeState(facts, store);
    const strictest = (verdicts: ModeVerdict[]) =>
      verdicts.reduce((a, b) => (STRICTNESS[b.verdict] > STRICTNESS[a.verdict] ? b : a));
    const out: { name: string; verdict: ModeVerdict; definition?: ToolDefinition }[] = [];
    // The harness's tools: only `tool:` rules decide whether they are offered.
    const toolRules = (l: RuleLayer): RuleLayer => {
      const only = (list?: readonly string[]) => list?.filter((e) => e.startsWith("tool:"));
      return {
        ...l,
        rules: { allow: only(l.rules.allow), ask: only(l.rules.ask), deny: only(l.rules.deny) },
      };
    };
    const byTool = (m: ResolvedMode): ResolvedMode => ({
      ...m,
      allow: m.allow.filter((r) => "tool" in r),
      ask: m.ask.filter((r) => "tool" in r),
      deny: m.deny.filter((r) => "tool" in r),
    });
    for (const name of new Set(harness)) {
      const req = toolRequest({ id: `harness/${name}`, name, action: "write" });
      const denied = [mode, ...extra].some(
        (m) =>
          !m ||
          matchRules(req, { mode: byTool(m), layers: layers.map(toolRules) })?.verdict === "deny",
      );
      if (!denied) out.push({ name, verdict: { verdict: "allow", reason: "a harness tool" } });
    }
    // The plugin tools of the session's pinned agent.
    const found = await this.#definitions.session(facts.session);
    if (!found || found.user !== facts.user || found.project !== facts.project) return out;
    const requested = new Set(found.run?.tools ?? []);
    // A remote MCP server's tools are listed now, so its agent's patterns decide (#135).
    const mcpRequested = (id: string) => found.run?.mcpTools?.some((p) => matches(p, id)) ?? false;
    const allow = this.#allow(access.grants);
    const local = await catalogToolDefinitions(found.catalog);
    const remote = found.run?.mcpTools?.length
      ? await this.#mcpTools(facts, found.catalog, new Set(local.map((d) => d[TOOL_EXTENSION].id)))
      : [];
    for (const definition of [...local, ...remote]) {
      const x = definition[TOOL_EXTENSION];
      const asked = x.source === "mcp" ? mcpRequested(x.id) : requested.has(x.id);
      if (!asked || !(await allow("tools", x.id, x.action))) continue;
      const req = toolRequest(x);
      const decideIn = (m: ResolvedMode | undefined): ModeVerdict => {
        if (!m) return { verdict: "deny", reason: "an unknown sub-agent mode", step: "mode" };
        if (m.classifier) {
          const d = decideAuto(req, { mode: m, layers, protectedPaths: this.#auto.protectedPaths });
          return d.step === "classifier"
            ? { verdict: "classify", reason: d.reason, step: "classifier" }
            : { verdict: d.verdict, reason: d.reason, step: d.step };
        }
        const d = decideMode(req, { mode: m, layers });
        return {
          verdict: d.verdict,
          reason: d.reason,
          step: d.source === "mode" ? "mode" : "rule",
        };
      };
      let verdict = strictest([decideIn(mode), ...extra.map(decideIn)]);
      if (verdict.verdict !== "classify")
        verdict = settleAsk(verdict as ModeVerdict & { verdict: "allow" | "ask" | "deny" }, facts);
      if (!recorded) delete verdict.step;
      if (verdict.verdict !== "deny") out.push({ name: x.name, verdict, definition });
    }
    return out;
  }

  /**
   * The tools an agent session is offered now (see #toolSet): the plugin tools as their
   * documents, the harness's by name. The agent session offers exactly these to its model and
   * lists them on its MCP endpoint.
   */
  async sessionTools(
    agentCapability: string,
    harness: readonly string[],
  ): Promise<{ harness: string[]; tools: ToolDefinition[] }> {
    const facts = await this.#authority.agentSessionOf(agentCapability);
    const set = await this.#toolSet(facts, harness.map(String));
    return {
      harness: set.filter((t) => !t.definition).map((t) => t.name),
      tools: set.flatMap((t) => (t.definition ? [t.definition] : [])),
    };
  }

  /**
   * Calls one plugin tool of an agent session, re-checked now against the session's current set:
   * a tool it is not offered is refused (EACCES), a call the mode asks about waits on an approval
   * of exactly that call (unless the user granted it), and in `auto` the risk classifier judges
   * what no rule or safe class settles. A REST tool's request is rebuilt from its route and sent
   * through the gateway, which adds the key from the secrets; the answer never holds it.
   */
  async callTool(
    agentCapability: string,
    call: { name: string; args?: unknown; turn?: string },
  ): Promise<{
    output: string;
    isError: boolean;
    secrets?: string[];
    warnings?: WarningView[];
    executor_cpu_ms?: number;
  }> {
    const facts = await this.#authority.agentSessionOf(agentCapability);
    const name = String(call?.name);
    const args = (call?.args ?? {}) as Record<string, unknown>;
    if (!args || typeof args !== "object" || Array.isArray(args))
      throw codedError("EINVAL", "a tool's arguments are an object");
    const found = (await this.#toolSet(facts, [])).find((t) => t.name === name && t.definition);
    if (!found?.definition)
      throw codedError("EACCES", `the tool '${name}' is not offered to this session`);
    const x = found.definition[TOOL_EXTENSION];
    const { verdict } = found;
    if (verdict.verdict !== "allow") {
      const content = new TextEncoder().encode(JSON.stringify(args));
      const id = await approvalId(facts.session, "tool", name, content);
      const request: ApprovalRequest = {
        id,
        session: facts.session,
        project: facts.project,
        action: { method: "tool", path: name, size: content.length },
        permission: x.permission,
        reason: verdict.reason,
      };
      const record = async (d: Omit<GateDecision, "action">) => {
        if (!verdict.step) return;
        try {
          await agentOf(this.env, facts.session).gateDecision({ action: request.action, ...d });
        } catch (e) {
          console.warn(`decision item of ${facts.session}: ${String((e as Error)?.message ?? e)}`);
        }
      };
      if (await this.#registry.consume(id, facts.session, facts.user)) {
        await record({
          step: "approval",
          verdict: "allow",
          reason: "the user approved this action",
        });
      } else if (verdict.verdict === "classify") {
        const c = await this.#classify(facts, await this.#store, request);
        await record({
          step: "classifier",
          verdict: c.verdict,
          reason: c.reason,
          ...(c.model ? { model: c.model } : {}),
          latency_ms: c.latency_ms,
          ...(c.fallback ? { fallback: c.fallback } : {}),
          ...(c.stop ? { stop: c.stop } : {}),
          ...(c.verdict === "deny"
            ? {
                approval: id,
                request: { ...request, reason: c.reason },
                stored: { method: "tool", path: name, content },
              }
            : {}),
        });
        if (c.verdict === "deny")
          throw codedError(
            "EACCES",
            `may not call ${name}: the risk classifier denied it: ${c.reason} (blocked: the user may approve a retry, ${id})`,
          );
        if (c.verdict === "ask") throw approvalError({ ...request, reason: c.reason });
      } else {
        await record({ step: verdict.step ?? "mode", verdict: "ask", reason: verdict.reason });
        throw approvalError(request);
      }
    }
    const route = x.route;
    if (route.kind === "rest" || route.kind === "mcp") {
      let request: OutgoingRequest;
      try {
        request =
          route.kind === "rest"
            ? restRequest(found.definition, args)
            : mcpRequest(route, "tools/call", { name: route.name, arguments: args }, 1);
      } catch (e) {
        return { output: String((e as Error)?.message ?? e), isError: true };
      }
      let result: GatewayResult & { warnings?: WarningView[] };
      try {
        result = await this.#meteredFetch(facts, request, x.plugin, call.turn);
      } catch (e) {
        // A limit on outbound requests refuses the call; the agent carries on (#179).
        if (codeOf(e) === "ELIMIT") return { output: String((e as Error).message), isError: true };
        throw e;
      }
      const secrets = result.secrets.length ? { secrets: result.secrets } : {};
      const warnings = result.warnings?.length ? { warnings: result.warnings } : {};
      if (result.error) return { output: result.error, isError: true, ...secrets, ...warnings };
      if (route.kind === "mcp") {
        // The remote server's answer: its own auth applies (a refusal is an error result).
        const answer = mcpAnswer(result, 1);
        const out =
          answer.result === undefined
            ? { output: answer.error, isError: true }
            : mcpCallOutput(answer.result);
        return { ...out, ...secrets, ...warnings };
      }
      return {
        output: `${result.status} ${result.body ?? ""}`,
        isError: !result.ok,
        ...secrets,
        ...warnings,
      };
    }
    if (route.kind === "native") return this.#runNative(agentCapability, facts, x, args, call.turn);
    return {
      output: `ENOSYS: ${route.kind} tools do not run in this deployment`,
      isError: true,
    };
  }

  /**
   * The tools of the remote MCP servers of a session's pinned plugins, listed by the host-side
   * gateway (statewalker/statewalker-root#135): each Streamable HTTP server is asked `tools/list`
   * (every page) through the secrets gateway, metered as outbound requests of the session's
   * member, project and workspace, and its tools become tool definitions of its plugin. A listing
   * is kept for the session while its time to live lasts (at most five minutes); a server that
   * fails gives no tools for a short while. stdio servers and servers whose files hold
   * credentials give none: they answer ENOSYS or EINVAL, logged.
   */
  async #mcpTools(
    facts: AgentSessionFacts,
    catalog: FilesApi,
    taken: ReadonlySet<string>,
  ): Promise<ToolDefinition[]> {
    const out: ToolDefinition[] = [];
    const names = new Set(taken);
    for (const server of await catalogMcpServers(catalog)) {
      if (server.problem) {
        console.warn(`MCP server ${server.plugin}/${server.server}: ${server.problem}`);
        continue;
      }
      const key = JSON.stringify([facts.session, server.plugin, server.server]);
      const now = Date.now();
      let entry = this.#mcpLists.get(key);
      if (!entry || entry.until <= now) {
        const listing = this.#listMcp(facts, server);
        entry = { until: now + MCP_LIST_TTL_MS, tools: listing.then((l) => l.tools) };
        const kept = entry;
        listing.then(
          (l) => {
            kept.until = Date.now() + l.ttl;
          },
          () => {},
        );
        this.#mcpLists.set(key, entry);
        if (this.#mcpLists.size > 512)
          this.#mcpLists.delete(this.#mcpLists.keys().next().value as string);
      }
      const ids = new Set<string>();
      for (const d of await entry.tools) {
        const id = d[TOOL_EXTENSION].id;
        if (names.has(id)) continue;
        ids.add(id);
        out.push(d);
      }
      for (const id of ids) names.add(id);
    }
    return out;
  }

  /** One server's tools, every page; none (and a short time to live) when listing fails. */
  async #listMcp(
    facts: AgentSessionFacts,
    server: McpServer,
  ): Promise<{ tools: ToolDefinition[]; ttl: number }> {
    const where = `MCP server ${server.plugin}/${server.server}`;
    const listed: unknown[] = [];
    let ttl = MCP_LIST_TTL_MS;
    let cursor: string | undefined;
    try {
      for (let page = 0; page < MCP_LIST_PAGES; page++) {
        const request = mcpRequest(
          { url: String(server.url), headers: server.headers },
          "tools/list",
          cursor !== undefined ? { cursor } : {},
          page + 1,
        );
        const answer = mcpAnswer(await this.#meteredFetch(facts, request, server.plugin), page + 1);
        if (answer.error) {
          console.warn(`${where}: tools/list: ${answer.error}`);
          return { tools: [], ttl: MCP_LIST_FAILURE_MS };
        }
        const { tools, nextCursor, ttlMs } = answer.result as {
          tools?: unknown;
          nextCursor?: unknown;
          ttlMs?: unknown;
        };
        if (Array.isArray(tools)) listed.push(...tools);
        if (typeof ttlMs === "number" && ttlMs >= 0) ttl = Math.min(ttl, ttlMs);
        if (typeof nextCursor !== "string" || !nextCursor) break;
        cursor = nextCursor;
      }
    } catch (e) {
      console.warn(`${where}: tools/list: ${String((e as Error)?.message ?? e)}`);
      return { tools: [], ttl: MCP_LIST_FAILURE_MS };
    }
    const { tools, problems } = mcpTools(server, listed);
    if (problems.length) console.warn(`${where}: ${problems.join("; ")}`);
    return { tools, ttl };
  }

  /** The deployment catalog's plugin bundles approved to run native tools, by hash. */
  #approvedBundles(): Set<string> {
    return new Set(
      String(this.env.APPROVED_BUNDLES ?? "")
        .split(/[\s,]+/)
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
    );
  }

  /**
   * One call of a native tool script (statewalker/statewalker-root#130), already allowed: its
   * bundle, as the session pinned it, runs in an isolate of its own with the capability the
   * workspace narrows for the tool (the session's files and databases, and the plugin's private
   * databases). A deployment catalog bundle runs only once approved by hash; workspace and project
   * plugins passed the acceptance check when they were built. The isolate's time is charged to the
   * workspace, project and member (`executor_cpu_ms:isolate`) as it runs, and the run is ended when
   * a limit refuses more, or at TOOL_TIMEOUT_MS. Python scripts answer ENOSYS until the
   * code-execution ticket.
   */
  async #runNative(
    agentCapability: string,
    facts: AgentSessionFacts,
    x: ToolExtension,
    args: Record<string, unknown>,
    turn: string | undefined,
  ): Promise<{ output: string; isError: boolean; executor_cpu_ms?: number }> {
    const route = x.route;
    if (route.kind !== "native") throw codedError("EINVAL", `${x.name} is not a native tool`);
    if (route.language === "python")
      return { output: `ENOSYS: Python tools do not run in this deployment yet`, isError: true };
    const loader = this.env.LOADER;
    if (!loader || route.language !== "js" || !route.bundle)
      return { output: `ENOSYS: native tools do not run in this deployment`, isError: true };
    const found = await this.#definitions.session(facts.session);
    const pin = found?.pins.find((p) => p.name === x.plugin);
    if (!found || !pin) throw codedError("EACCES", `the tool '${x.name}' is not pinned`);
    if ((pin.level ?? "deployment") === "deployment" && !this.#approvedBundles().has(pin.hash))
      return {
        output: `EACCES: the plugin bundle ${x.plugin} (sha256 ${pin.hash}) is not approved to run its tools in this deployment (APPROVED_BUNDLES)`,
        isError: true,
      };
    const code = await tryReadText(found.catalog, `/${x.plugin}/${route.bundle}`);
    if (code === undefined) throw codedError("ENOENT", `the bundle of ${x.name} is missing`);
    const capability = await this.forTool(agentCapability, { plugin: x.plugin, tool: x.tool });
    // An action the mode asks about is refused: a running tool cannot wait for an approval.
    const files = filesOverRpc(
      (method, a) =>
        this.#files.call(capability, method, a).catch((e) => {
          const asked = approvalOf(e);
          if (!asked) throw e;
          throw codedError(
            "EACCES",
            `the mode asks before this (${asked.reason}), and a tool cannot wait for an approval`,
          );
        }),
      { blockSize: blockSizeOf(this.env) },
    );
    const db = (name: string) =>
      databaseOf(
        {
          call: (req) => this.#databases.call(capability, req),
          manage: async () => {},
          list: async () => [],
        },
        name.includes(":") ? name : `${x.plugin}:${name}`,
      );
    const host = new ToolHost({
      async read(path, start, length) {
        const parts: Uint8Array[] = [];
        let n = 0;
        const options = {
          ...(typeof start === "number" ? { start } : {}),
          ...(typeof length === "number" ? { length } : {}),
        };
        for await (const chunk of files.read(path, options)) {
          n += chunk.length;
          if (n > MAX_TOOL_READ)
            throw codedError("EINVAL", `${path} is larger than a tool may read at once`);
          parts.push(chunk);
        }
        const out = new Uint8Array(n);
        let at = 0;
        for (const p of parts) {
          out.set(p, at);
          at += p.length;
        }
        return out;
      },
      write: (path, data) => files.write(path, [new Uint8Array(data)]),
      mkdir: (path) => files.mkdir(path),
      async list(path, recursive) {
        const out: unknown[] = [];
        for await (const e of files.list(path, { recursive })) {
          out.push({ ...e });
          if (out.length > MAX_TOOL_LIST)
            throw codedError("EINVAL", `${path} lists too many entries`);
        }
        return out;
      },
      stats: async (path) => (await files.stats(path)) ?? null,
      exists: (path) => files.exists(path),
      remove: (path) => files.remove(path),
      move: (source, target) => files.move(source, target),
      copy: (source, target) => files.copy(source, target),
      async dbQuery(name, sql, params) {
        const d = db(name);
        try {
          return await d.query(sql, params);
        } finally {
          await d.close();
        }
      },
      async dbExec(name, sql) {
        const d = db(name);
        try {
          await d.exec(sql);
        } finally {
          await d.close();
        }
      },
    });
    const meter = "executor_cpu_ms:isolate";
    const meta = this.#limits.meta(
      facts.project,
      facts.user,
      facts.session,
      this.#turnOf(facts.session, turn),
    );
    const detail = { tool: x.id };
    const timeout = Number(this.env.TOOL_TIMEOUT_MS);
    const result = await runBundle(loader, {
      code,
      input: args,
      host,
      timeoutMs: timeout > 0 ? timeout : 30_000,
      charge: async (ms) => {
        await this.#limits.charge(facts.project, facts.user, { [meter]: ms }, meta, detail);
      },
      record: async (ms) => {
        const scopes = await this.#limits.scopes(facts.project, facts.user);
        this.#limits.ledger.add(scopes, { [meter]: ms }, meta, detail);
      },
    });
    return { output: result.output, isError: result.isError, executor_cpu_ms: result.ms };
  }

  /** Test-only, and the storage meter's input (#179): every database and the bytes it takes. */
  async databaseStorage() {
    return this.#databases.storage();
  }

  /**
   * The user session's mode and the user's own rules, pushed by their User DO with its user
   * capability (an agent session's capability is refused: only the user switches modes).
   */
  async setUserSession(
    userCapability: string,
    state: { mode: string; rules: PermissionRules },
  ): Promise<void> {
    const user = await this.#authority.userOfUserCapability(userCapability);
    if (!isMode(state.mode, this.#modes)) throw codedError("EINVAL", `no mode '${state.mode}'`);
    this.#registry.setUserSession(user, { mode: state.mode, rules: parseRules(state.rules) });
  }

  /** An approval the user granted, pushed by their User DO with its user capability. */
  async grantApproval(userCapability: string, grant: ApprovalGrant): Promise<void> {
    const user = await this.#authority.userOfUserCapability(userCapability);
    this.#registry.grant(user, grant);
  }

  #deploymentSecrets() {
    // A browser deployment has none, whatever it was given.
    if (this.#browser) return deploymentSecrets(undefined, {});
    return deploymentSecrets(
      this.env.DEPLOYMENT_SECRETS,
      this.env as unknown as Record<string, unknown>,
    );
  }

  /**
   * `secrets.write:<level>` for a user capability's user, and the scope its rows are kept under.
   * Users manage their own secrets; a project's are managed with a project role granting
   * `secrets.write:project` (owners), the workspace's with a workspace role granting
   * `secrets.write:workspace` (the admin). Deployment secrets are the runtime's: listed with
   * `secrets.write:workspace`, written by nobody.
   */
  async #secretScope(
    capability: string,
    scope: SecretScope,
    write: boolean,
  ): Promise<{ level: StoredLevel | "deployment"; scope: string }> {
    const user = await this.#authority.userOfUserCapability(capability);
    const refuse = () => codedError("EACCES", `${user} may not manage ${scope.level} secrets here`);
    const holds = (grants: readonly RoleGrant[], target: string) =>
      decide(grants, { area: "secrets", action: "write", target });
    // A browser page holds only its users' own secrets: nothing above user level is ever written.
    if (this.#browser && write && scope.level !== "user")
      throw codedError("EACCES", `a browser deployment keeps no ${scope.level} secrets`);
    switch (scope.level) {
      case "user":
        return { level: "user", scope: user };
      case "project": {
        const project = String(scope.project);
        const access = await this.#access(project, user);
        // Only project roles: a workspace role never reaches a project's secrets.
        const grants = access.grants.filter((g) => !Object.hasOwn(WORKSPACE_ROLES, g.role));
        if (!access.member || !holds(grants, "project")) throw refuse();
        return { level: "project", scope: project };
      }
      case "workspace":
      case "deployment": {
        // Only workspace roles: a project's custom role can't grant `secrets.write:workspace`.
        const held = (await this.#roles.workspaceRoles(user)).filter((r) =>
          Object.hasOwn(WORKSPACE_ROLES, r),
        );
        if (!holds(resolveRoles(held, {}).grants, "workspace")) throw refuse();
        if (scope.level === "deployment" && write) throw refuse();
        return { level: scope.level, scope: "" };
      }
      default:
        throw codedError("EINVAL", "no such secret level");
    }
  }

  #view(info: SecretInfo): SecretView {
    return {
      name: info.name,
      level: info.level,
      ...(info.level === "project" ? { project: info.scope } : {}),
      bindings: info.bindings,
      updated: info.updated,
    };
  }

  /** The secrets of one level the caller manages: never a value. */
  async listSecrets(capability: string, scope: SecretScope): Promise<SecretView[]> {
    const s = await this.#secretScope(capability, scope, false);
    const infos =
      s.level === "deployment"
        ? this.#deploymentSecrets().info
        : this.#secrets.list(s.level, s.scope);
    return infos.map((i) => this.#view(i));
  }

  /** Sets or replaces one secret (write-only: the answer never holds its value). */
  async setSecret(capability: string, req: SetSecretRequest): Promise<SecretView> {
    const s = await this.#secretScope(capability, req, true);
    if (s.level === "deployment")
      throw codedError("EACCES", "deployment secrets are runtime secrets");
    return this.#view(await this.#secrets.set(s.level, s.scope, req.name, req.value, req.bindings));
  }

  async deleteSecret(capability: string, req: DeleteSecretRequest): Promise<void> {
    const s = await this.#secretScope(capability, req, true);
    if (s.level === "deployment")
      throw codedError("EACCES", "deployment secrets are runtime secrets");
    if (!this.#secrets.delete(s.level, s.scope, req.name))
      throw codedError("ENOENT", `secret ${req.name} is not set`);
  }

  /** Deletes all the user-level secrets of a user capability's user (they are being erased). */
  async eraseUserSecrets(capability: string): Promise<void> {
    const user = await this.#authority.userOfUserCapability(capability);
    this.#secrets.deleteScope("user", user);
    this.#models.deleteUser(user);
  }

  /**
   * The host-side gateway for one outgoing request of a plugin in an agent session: its
   * `{{secret:NAME}}` placeholders resolve to the session's user's, project's, workspace's or the
   * deployment's secret, the most specific first, only where its binding names the plugin and the
   * request's host. Values are read now and never leave this DO except in the request itself; the
   * answer is redacted and names the secrets used.
   */
  async gatewayFetch(
    capability: string,
    call: { plugin: string; request: OutgoingRequest; turn?: string },
  ): Promise<GatewayResult & { warnings?: WarningView[] }> {
    const facts = await this.#authority.agentSessionOf(capability);
    if (!(await this.#access(facts.project, facts.user)).member)
      throw codedError("EACCES", `${facts.user} is not a member of ${facts.project}`);
    return this.#meteredFetch(facts, call.request, String(call.plugin), call.turn);
  }

  /**
   * One outgoing request of a plugin, metered (#179): outbound requests and bytes are charged to
   * the workspace, project and member, and a request over a limit is refused before it is sent;
   * the answer's bytes are counted after.
   */
  async #meteredFetch(
    facts: AgentSessionFacts,
    request: OutgoingRequest,
    plugin: string,
    turn?: string,
  ): Promise<GatewayResult & { warnings?: WarningView[] }> {
    const lookup = sessionSecrets(this.#secrets, this.#deploymentSecrets(), facts);
    const meta = this.#limits.meta(
      facts.project,
      facts.user,
      facts.session,
      this.#turnOf(facts.session, turn),
    );
    let host = "";
    try {
      host = new URL(String(request?.url)).host;
    } catch {
      // gatewayFetch refuses it.
    }
    const sent = new TextEncoder().encode(String(request?.body ?? "")).length;
    const detail = { plugin, host };
    const warnings = await this.#limits.charge(
      facts.project,
      facts.user,
      { outbound_requests: 1, outbound_bytes: sent },
      meta,
      detail,
    );
    const result = await gatewayFetch(request, plugin, lookup);
    const received =
      "body" in result ? new TextEncoder().encode(String(result.body ?? "")).length : 0;
    warnings.push(
      ...this.#limits.ledger.add(
        await this.#limits.scopes(facts.project, facts.user),
        { outbound_bytes: received },
        meta,
        detail,
      ),
    );
    return { ...result, ...(warnings.length ? { warnings: warnings.map(warningView) } : {}) };
  }

  /**
   * Puts a capability on the revocation list, for the user session holding the user capability it
   * was narrowed from (or that user capability itself): it, and every capability narrowed from it,
   * is refused from its next use on.
   */
  async revoke(userCapability: string, capability: string): Promise<void> {
    const id = await this.#authority.revocationOf(userCapability, capability);
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO revocations VALUES (?, ?)", id, Date.now());
    // The remote tasks of every session narrowed from it stop too (#144): UHP cancel, sent here,
    // where the server's token is, since their capability no longer reaches the gate.
    await this.#cancelRemote(id);
  }

  /**
   * Starts a sub-agent of an agent session (statewalker/statewalker-root#126), for the user session
   * that session's capability was narrowed from: the agent must be one the parent's pinned
   * definition lists and the user may use now; the child's definitions are pinned like any
   * session's, and its capability is the parent's with a block this workspace signs, naming the
   * child and any mode (asked for, or its definition's) that may only make the gate stricter.
   */
  async delegate(
    userCapability: string,
    parentCapability: string,
    grant: { session: string; agent: string; mode?: string },
  ): Promise<{
    capability: string;
    agent: string;
    run?: AgentRun;
    model?: string;
    plugins?: string[];
    limits?: Limit[];
    ownKeys?: boolean;
  }> {
    // The parent must be narrowed from this very user session (revocation ids name it).
    await this.#authority.revocationOf(userCapability, parentCapability);
    const parent = await this.#authority.agentSessionOf(parentCapability);
    const pinned = await this.#definitions.session(parent.session);
    const listed =
      pinned?.user === parent.user && pinned.project === parent.project
        ? (pinned.run?.agents ?? [])
        : [];
    if (!listed.includes(String(grant.agent)))
      throw codedError("EACCES", `${parent.agent} may not start '${grant.agent}'`);
    if (grant.mode !== undefined && !isMode(grant.mode, this.#modes))
      throw codedError("EINVAL", `no mode '${grant.mode}'`);
    const child = await this.pinDefinitions(userCapability, {
      session: grant.session,
      project: parent.project,
      agent: grant.agent,
    });
    // A mode the definition asks for, like one the parent asks for, may only be stricter.
    const modes = [grant.mode, child.run?.mode].filter((m): m is string => !!m);
    const capability = await this.#authority.delegate(userCapability, parentCapability, {
      session: grant.session,
      agent: child.agent,
      modes,
    });
    return {
      capability,
      agent: child.agent,
      ...(child.run ? { run: child.run } : {}),
      ...(child.model ? { model: child.model } : {}),
      ...(child.plugins ? { plugins: child.plugins } : {}),
      ...(child.limits ? { limits: child.limits } : {}),
      ...(child.ownKeys ? { ownKeys: true } : {}),
    };
  }

  /** Refuses (EACCES) a user capability whose user is not the workspace's admin. */
  async #admin(userCapability: string): Promise<void> {
    const user = await this.#authority.userOfUserCapability(userCapability);
    const held = (await this.#roles.workspaceRoles(user)).filter((r) =>
      Object.hasOwn(WORKSPACE_ROLES, r),
    );
    const grants = resolveRoles(held, {}).grants;
    if (!decide(grants, { area: "members", action: "manage", target: "workspace" }))
      throw codedError("EACCES", `${user} may not manage this workspace's service accounts`);
  }

  /**
   * The workspace's service accounts (statewalker/statewalker-root#127): non-human users that sign
   * in with an API key and hold project roles like any user. The issuer keeps them; the workspace
   * admin manages them, through here.
   */
  async listServiceAccounts(userCapability: string): Promise<ServiceAccountView[]> {
    await this.#admin(userCapability);
    return issuerOf(this.env).listServiceAccounts(this.#name);
  }

  async createServiceAccount(userCapability: string, name: string): Promise<CreatedServiceAccount> {
    await this.#admin(userCapability);
    return issuerOf(this.env).createServiceAccount(this.#name, String(name));
  }

  async deleteServiceAccount(userCapability: string, name: string): Promise<void> {
    await this.#admin(userCapability);
    await issuerOf(this.env).deleteServiceAccount(this.#name, String(name));
  }

  // ---- memory (statewalker/statewalker-root#157) ----------------------------------------------

  /**
   * Who holds a capability for memory: an agent session (its facts) or a user session. A
   * capability narrowed for a plugin's tool never reaches memory: only the agent, through the
   * memory tool, does.
   */
  async #memoryHolder(capability: string) {
    const facts = await this.#authority.agentSessionOf(capability).catch(() => undefined);
    if (facts?.tool) throw codedError("EACCES", "a tool's capability does not reach memory");
    const user = facts?.user ?? (await this.#authority.userOfUserCapability(capability));
    return { facts, user };
  }

  /** A project's memory caps: the deployment's, overridden by the project's `.system/memory-caps`. */
  async #memoryCaps(project: string, store: FilesApi) {
    return parseMemoryCaps(
      this.env.MEMORY_CAPS,
      await tryReadText(store, `/${project}/${DEFAULT_SYSTEM_FOLDER}/${MEMORY_CAPS_FILE}`),
    );
  }

  /**
   * The values of every secret stored for a user in a project: theirs, the project's, the
   * workspace's and the deployment's. Only the memory scans read them, here.
   */
  async #secretValues(project: string | undefined, user: string): Promise<string[]> {
    const values = [
      ...(await this.#secrets.values("user", user)),
      ...(project ? await this.#secrets.values("project", project) : []),
      ...(await this.#secrets.values("workspace", "")),
    ];
    const deployment = this.#deploymentSecrets();
    for (const info of deployment.info) {
      const value = deployment.open(info.name)?.value;
      if (value) values.push(value);
    }
    return values;
  }

  /**
   * The memory service on a project's own memory and one agent's, in the project's system folder
   * (never in any file view). Writes count against the project's storage limits and are refused
   * over one before anything lands (#179).
   */
  async #memoryService(project: string, user: string, agent?: string): Promise<MemoryService> {
    const store = await this.#store;
    const metered = this.#meteredStore(store);
    const base = `/${project}/${DEFAULT_SYSTEM_FOLDER}/${MEMORY_FOLDER}`;
    const stores: Partial<Record<MemoryKind, FilesApi>> = {
      project: rootedFiles(metered, `${base}/project`),
    };
    if (agent) stores.agent = rootedFiles(metered, `${base}/agents/${agent}`);
    return new MemoryService({
      files: memoryFiles(stores),
      kinds: Object.keys(stores) as MemoryKind[],
      caps: await this.#memoryCaps(project, store),
      secretValues: () => this.#secretValues(project, user),
      admit: (_kind, delta) =>
        this.#limits.admitStorage(project, delta, store, () => this.#databases.storage()),
      lock: this.#memoryLock,
      lockKey: (kind) => `${project}/${kind === "agent" ? `agent:${agent}` : kind}`,
    });
  }

  /**
   * How the mode and the rules decide an agent session's memory write of a kind: plan denies it,
   * a deny rule denies it, an ask waits on an approval of exactly that batch (unless `mayAsk` is
   * false: preferences ask the user themselves, in every mode), and unattended asks deny.
   */
  async #memoryMode(
    facts: AgentSessionFacts,
    kind: MemoryKind,
    content: string,
    mayAsk: boolean,
  ): Promise<void> {
    const store = await this.#store;
    const { mode } = await this.#modeState(facts, store);
    const decideOne = await this.#decider(facts, store);
    const decision = this.#settled(decideOne("memory", "write", kind), facts);
    if (decision.verdict === "deny")
      throw codedError(
        "EACCES",
        `may not write ${kind} memory in ${mode.name} mode: ${decision.reason}`,
      );
    if (decision.verdict === "allow" || !mayAsk) return;
    const bytes = new TextEncoder().encode(content);
    const id = await approvalId(facts.session, "memory", kind, bytes);
    const request: ApprovalRequest = {
      id,
      session: facts.session,
      project: facts.project,
      action: { method: "memory", path: kind, size: bytes.length },
      permission: `memory.write:${kind}`,
      reason: decision.reason,
    };
    // A granted approval is used up before the classifier is asked: a block's retry passes.
    if (this.#registry.consume(id, facts.session, facts.user)) return;
    if (decision.verdict === "classify") {
      // `auto`: the risk classifier judges the batch, as it judges file and database changes.
      const c = await this.#classify(facts, store, request);
      await this.#record(facts, {
        action: request.action,
        step: "classifier",
        verdict: c.verdict,
        reason: c.reason,
        ...(c.model ? { model: c.model } : {}),
        latency_ms: c.latency_ms,
        ...(c.fallback ? { fallback: c.fallback } : {}),
        ...(c.stop ? { stop: c.stop } : {}),
        ...(c.verdict === "deny"
          ? {
              approval: id,
              request: { ...request, reason: c.reason },
              stored: { method: "memory", path: kind, content: bytes },
            }
          : {}),
      });
      if (c.verdict === "allow") return;
      if (c.verdict === "deny")
        throw codedError(
          "EACCES",
          `may not write ${kind} memory: the risk classifier denied it: ${c.reason} (blocked: the user may approve a retry, ${id})`,
        );
      throw approvalError({ ...request, reason: c.reason });
    }
    throw approvalError(request);
  }

  /**
   * One memory call on project or agent memory (the memory tool's, with an agent session's
   * capability; the memory API's, with a user session's). Every member reads both; writing takes
   * `memory.write:project` or `memory.write:agent` (owners and editors), and an agent session's
   * write also its mode. An agent session reaches its own project and its own agent's memory only;
   * only a person erases. A project or kind the caller cannot reach answers ENOENT.
   */
  async memory(capability: string, raw: MemoryCall): Promise<unknown> {
    const call = memoryCall(raw);
    const { facts, user } = await this.#memoryHolder(capability);
    const project = facts ? facts.project : projectName(call.project);
    const access = await this.#access(project, user).catch(() => undefined);
    if (!access?.member) throw codedError("ENOENT", "no such memory");
    if (call.op === "agents") return { agents: await this.#agentMemories(project, user) };
    if ((call.op as string) === "prime") {
      if (!facts) throw codedError("EINVAL", "only agent sessions are primed");
      return (await this.#memoryService(project, user, facts.agent)).prime(["project", "agent"]);
    }
    const ref = memoryRef(call.kind);
    if (ref.kind !== "project" && ref.kind !== "agent")
      throw codedError("ENOENT", "no such memory");
    let agent = ref.agent;
    if (ref.kind === "agent" && facts) {
      if (agent && agent !== facts.agent) throw codedError("ENOENT", "no such memory");
      agent = facts.agent;
    }
    if (ref.kind === "agent" && !agent) throw codedError("ENOENT", "no such memory");
    if (writes(call)) {
      if (facts && call.op === "erase") throw codedError("EACCES", "only a person erases memory");
      // Only project roles: a workspace role never writes a project's memory.
      const grants = access.grants.filter((g) => !Object.hasOwn(WORKSPACE_ROLES, g.role));
      if (!decide(grants, { area: "memory", action: "write", target: ref.kind }))
        throw codedError("EACCES", `${user} may not write ${ref.kind} memory in ${project}`);
      if (facts) await this.#memoryMode(facts, ref.kind, JSON.stringify(call.actions ?? []), true);
    }
    const writer: Writer = facts ? { user, agent: facts.agent, session: facts.session } : { user };
    return runMemoryCall(await this.#memoryService(project, user, agent), ref.kind, call, writer);
  }

  /** A project's agent memories: one folder per agent, `<plugin>/<agent>`. */
  async #agentMemories(project: string, user: string) {
    const store = await this.#store;
    const base = `/${project}/${DEFAULT_SYSTEM_FOLDER}/${MEMORY_FOLDER}/agents`;
    const agents: { agent: string; usage: unknown }[] = [];
    if (!(await store.exists(base))) return agents;
    for await (const plugin of store.list(base)) {
      if (plugin.kind !== "directory") continue;
      for await (const a of store.list(plugin.path)) {
        if (a.kind !== "directory") continue;
        const agent = `${plugin.name}/${a.name}`;
        const view = await (await this.#memoryService(project, user, agent)).list("agent");
        agents.push({ agent, usage: view.usage });
      }
    }
    return agents.sort((a, b) => a.agent.localeCompare(b.agent));
  }

  /**
   * What a User DO asks before it reaches a profile kind (user memory, preferences): the
   * capability verified, the membership (ENOENT for an agent session outside it), a sub-agent's
   * limits (it writes neither), and the mode for a write (plan denies it; a rule's ask on user
   * memory waits on an approval). It answers who writes and the project's caps.
   */
  async memoryAccess(
    capability: string,
    req: { kind: "user" | "preferences"; project?: string; write: boolean; content?: string },
  ) {
    const { facts, user } = await this.#memoryHolder(capability);
    const kind: MemoryKind = req.kind === "preferences" ? "preferences" : "user";
    const store = await this.#store;
    if (facts) {
      const access = await this.#access(facts.project, user).catch(() => undefined);
      if (!access?.member) throw codedError("ENOENT", "no such memory");
      if (req.write) {
        if (facts.parent)
          throw codedError(
            "EACCES",
            "a sub-agent writes only its own agent memory and the project memory",
          );
        await this.#memoryMode(facts, kind, String(req.content ?? ""), kind === "user");
      }
      return {
        user,
        project: facts.project,
        member: true,
        exists: true,
        caps: await this.#memoryCaps(facts.project, store),
        writer: { user, agent: facts.agent, session: facts.session },
      };
    }
    if (kind === "preferences")
      return {
        user,
        member: true,
        exists: true,
        caps: parseMemoryCaps(this.env.MEMORY_CAPS),
        writer: { user },
      };
    const project = projectName(req.project);
    const member = !!(await this.#access(project, user).catch(() => undefined))?.member;
    return {
      user,
      project,
      member,
      exists: await store.exists(`/${project}`),
      caps: member ? await this.#memoryCaps(project, store) : parseMemoryCaps(this.env.MEMORY_CAPS),
      writer: { user },
    };
  }

  /**
   * The memory scans for a User DO's profile kinds, run here, where the secrets are: their values
   * never leave this DO.
   */
  async scanMemory(
    capability: string,
    req: { project?: string; texts: string[] },
  ): Promise<(string | undefined)[]> {
    const { facts, user } = await this.#memoryHolder(capability);
    const project = facts?.project ?? (req.project ? projectName(req.project) : undefined);
    const values = await this.#secretValues(project, user);
    return (Array.isArray(req.texts) ? req.texts : []).map((t) => scanText(String(t), values));
  }

  /**
   * A user is being erased: their entries in every project's and agent's memory here stay, with
   * `written_by` (and `forgotten_by`) set to the fixed "deleted user" id.
   */
  async replaceMemoryAuthor(userCapability: string): Promise<void> {
    const user = await this.#authority.userOfUserCapability(userCapability);
    const store = await this.#store;
    for await (const p of store.list("/")) {
      if (p.kind !== "directory") continue;
      const base = `/${p.name}/${DEFAULT_SYSTEM_FOLDER}/${MEMORY_FOLDER}`;
      if (!(await store.exists(base))) continue;
      await (await this.#memoryService(p.name, user)).replaceAuthor("project", user, DELETED_USER);
      const agents = `${base}/agents`;
      if (!(await store.exists(agents))) continue;
      for await (const plugin of store.list(agents))
        if (plugin.kind === "directory")
          for await (const a of store.list(plugin.path))
            if (a.kind === "directory")
              await (
                await this.#memoryService(p.name, user, `${plugin.name}/${a.name}`)
              ).replaceAuthor("agent", user, DELETED_USER);
    }
  }

  /**
   * Test-only (the Worker admits this only with the ADMIN_KEY): deletes a project, its system
   * folder (so its project and agent memory) included. Its users' memory of it stays in their
   * profiles, which then show it as gone.
   */
  async deleteProject(project: string): Promise<void> {
    const name = projectName(project);
    await (await this.#store).remove(`/${name}`);
  }

  /**
   * Test-only (the Worker admits this only with the ADMIN_KEY): writes the workspace's SQL role
   * source. Harness tools, allowed to owners, replace this in a later ticket.
   */
  async setAccess(fixture: {
    project?: string;
    members?: Record<string, string[]>;
    roles?: Record<string, RoleEntries | null>;
    workspaceRoles?: Record<string, string[]>;
  }): Promise<void> {
    const { project } = fixture;
    if ((fixture.members || fixture.roles) && !project)
      throw codedError("EINVAL", "members and roles belong to a project");
    if (project && fixture.members) this.#sqlRoles.setMembers(project, fixture.members);
    if (project && fixture.roles) this.#sqlRoles.setRoles(project, fixture.roles);
    for (const [user, roles] of Object.entries(fixture.workspaceRoles ?? {}))
      this.#sqlRoles.setWorkspaceRoles(user, roles);
  }

  /** Test-only fixtures (the Worker admits this only with the ADMIN_KEY). */
  async seed(files: Record<string, string>): Promise<number> {
    const enc = new TextEncoder();
    const store = await this.#store;
    for (const [path, text] of Object.entries(files))
      await store.write(normalise(path), [enc.encode(text)]);
    return Object.keys(files).length;
  }
}
