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
  type ResolvedMode,
  type RoleEntries,
  type RoleGrant,
  type RoleSource,
  type RuleLayer,
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
  type Allow,
  buildPlugin,
  catalogToolDefinitions,
  catalogTools,
  definitionsView,
  findAgent,
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
  resolveModels,
  type SecretInfo,
  SecretStore,
  type StoredLevel,
  sessionSecrets,
  withDelay,
} from "@statewalker/ai-environment";
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

/** The definitions mount's folder in each project of an agent session's file view. */
const DEFINITIONS_FOLDER = ".agents";

/** The most a native tool reads of a file at once, and lists of a folder. */
const MAX_TOOL_READ = 16 * 1024 * 1024;
const MAX_TOOL_LIST = 10_000;

/** The workspace's and each project's model configuration, in their system folders. */
const MODELS_FILE = "models";

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
  /** The deployment's model configuration, read once from the MODELS var. */
  #deploymentModels?: ModelsConfig;
  /** The deployment catalog's plugins, read once from the CATALOG var. */
  #deploymentPlugins?: Promise<{ plugins: Plugin[]; problems: string[] }>;
  /** Plugin builds by level and source hash (statewalker/statewalker-root#130). */
  readonly #builds = new Map<string, Promise<{ plugin?: Plugin; problems: string[] }>>();

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
    return (area, target, action) =>
      decide(grants, { area, action: "use", target }) ||
      (area === "tools" && action === "read" && decide(grants, { area, action: "read", target }));
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
    const usable = async (id: string | undefined) => {
      if (!id) return undefined;
      const agent = await findAgent(catalog, id);
      return agent && (await allow("agents", agent.id)) ? agent : undefined;
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
      ? await narrowAgent(catalog, agent, allow)
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
    return gatedFilesRpc(store, options, agent ? this.#modeGate(agent, store) : undefined);
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
    const allow = this.#allow(access.grants);
    for (const definition of await catalogToolDefinitions(found.catalog)) {
      const x = definition[TOOL_EXTENSION];
      if (!requested.has(x.id) || !(await allow("tools", x.id, x.action))) continue;
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
    if (route.kind === "rest") {
      let request: OutgoingRequest;
      try {
        request = restRequest(found.definition, args);
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
      return {
        output: `${result.status} ${result.body ?? ""}`,
        isError: !result.ok,
        ...secrets,
        ...warnings,
      };
    }
    if (route.kind === "native") return this.#runNative(agentCapability, facts, x, args, call.turn);
    // Remote MCP servers' tools run with statewalker/statewalker-root#135.
    return {
      output: `ENOSYS: ${route.kind} tools do not run in this deployment yet`,
      isError: true,
    };
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
