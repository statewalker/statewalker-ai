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
  accessOf,
  chainRoleSources,
  codedError,
  DEFAULT_MODE,
  DEFAULT_SYSTEM_FOLDER,
  decide,
  decideMode,
  fileRoleSource,
  isMode,
  type ModeDefinition,
  modeOf,
  PERMISSION_RULES_FILE,
  type PermissionRules,
  parseRules,
  type RoleEntries,
  type RoleGrant,
  type RoleSource,
  resolveRoles,
  SqlRoleSource,
  type StoredRootKey,
  settleAsk,
  WORKSPACE_ROLES,
  WorkspaceAuthority,
} from "@statewalker/ai-access";
import {
  type Allow,
  definitionsView,
  findAgent,
  type NarrowedAgent,
  narrowAgent,
  type Plugin,
  readPlugins,
} from "@statewalker/ai-definitions";
import {
  type CatalogModel,
  checkModelsConfig,
  checkUserProvider,
  deploymentSecrets,
  discoverModels,
  FilesRpcHost,
  type FilesRpcMethod,
  type GatedFilesOptions,
  type GatewayResult,
  gatedFilesRpc,
  gatewayFetch,
  IGNORE_FILE,
  ignoreRules,
  type ModeGate,
  type ModelCall,
  type ModelCatalog,
  ModelGateway,
  type ModelLevel,
  type ModelResponse,
  type ModelRight,
  type ModelsConfig,
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
} from "@statewalker/ai-environment";
import type {
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
import { agentRun, DefinitionsStore } from "./definitions-store.js";
import {
  blockSizeOf,
  deploymentModes,
  deploymentRules,
  type Env,
  issuerOf,
  nameOf,
  verifyToken,
} from "./env.js";
import { ModelStore, type ModelUsageRecord } from "./model-store.js";
import { mountWorkspace } from "./workspace-store.js";

/** The definitions mount's folder in each project of an agent session's file view. */
const DEFINITIONS_FOLDER = ".agents";

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
  readonly #modes: Record<string, ModeDefinition>;
  readonly #deploymentRules: PermissionRules;
  readonly #secrets: SecretStore;
  readonly #definitions: DefinitionsStore;
  readonly #models: ModelStore;
  /** The deployment's model configuration, read once from the MODELS var. */
  #deploymentModels?: ModelsConfig;
  /** The deployment catalog's plugins, read once from the CATALOG var. */
  #deploymentPlugins?: Promise<{ plugins: Plugin[]; problems: string[] }>;

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
    this.#modes = deploymentModes(env);
    this.#deploymentRules = deploymentRules(env);
    // Workspace, project and user secrets: sealed rows in this DO's SQLite, never files.
    this.#secrets = new SecretStore({ sql, secretsKey: env.SECRETS_KEY, workspace: this.#name });
    this.#definitions = new DefinitionsStore(sql);
    this.#models = new ModelStore(sql);
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
    return (area, target) => decide(grants, { area, action: "use", target });
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
  async #plugins(project: string): Promise<Plugin[]> {
    const store = await this.#store;
    const levels = [
      await this.#readDeploymentPlugins(),
      await readPlugins(store, `/${DEFAULT_SYSTEM_FOLDER}/plugins`),
      await readPlugins(store, `/${project}/${DEFAULT_SYSTEM_FOLDER}/plugins`),
    ];
    const plugins: Plugin[] = [];
    const problems: string[] = [];
    for (const level of levels) {
      problems.push(...level.problems);
      for (const p of level.plugins)
        if (plugins.some((q) => q.name === p.name))
          problems.push(`${p.name}: already loaded at a broader level; skipped`);
        else plugins.push(p);
    }
    if (problems.length) console.warn(`plugins of ${project}: ${problems.join("; ")}`);
    return plugins;
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
    this.#models.pin(String(req.session), user, project, models);
    for (const p of plugins) this.#definitions.keep(p);
    this.#definitions.pin(
      String(req.session),
      user,
      project,
      plugins.map((p) => ({ name: p.name, hash: p.hash })),
      run,
    );
    return run
      ? { agent: run.id, run: agentRun(run), model: models.model }
      : { agent: "default", model: models.model };
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
      // The budget records every request; limits reserve and refuse in `admit` (#179).
      meter: { record: (usage, meta) => this.#models.record(usage, meta) },
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
      allow: async (area, target) => this.#allow(await grants())(area, target),
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
    const raw = await this.#store;
    const agent = await this.#authority.agentSessionOf(capability).catch(() => undefined);
    const user = agent?.user ?? (await this.#authority.userOfUserCapability(capability));
    const store = agent ? await this.#withDefinitions(raw, agent) : raw;
    const options: GatedFilesOptions = {
      systemFolder: DEFAULT_SYSTEM_FOLDER,
      blockSize: blockSizeOf(this.env),
      visible: (project) => this.#member(project, user),
      authorize: async (action, path) => {
        // An agent session acts in its project only; the user's own session in the path's.
        const project = agent?.project ?? path.split("/")[1] ?? "";
        if (!project) throw codedError("EACCES", `may not ${action} '${path}'`);
        const { grants } = await this.#access(project, user);
        await this.#authority.authorize(capability, { action, path, project, grants });
      },
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
   * The gate: one files-RPC call on the file view a capability holds (an agent session's, or a
   * user session's own), decided now. User, project and session come from the capability itself;
   * a capability this workspace did not sign is refused (EACCES).
   */
  async files(capability: string, method: FilesRpcMethod, args: unknown[]): Promise<unknown> {
    return this.#files.call(capability, method, args);
  }

  /** The mode and the rules of one agent session, as the gate decides them at every call. */
  #modeGate(facts: AgentSessionFacts, store: FilesApi): ModeGate {
    return {
      session: facts.session,
      project: facts.project,
      decide: async (checks) => {
        const root = `/${facts.project}`;
        // Read once per operation: the user session's mode and rules, and the project's rules.
        const state = this.#registry.userSession(facts.user);
        const name = state && isMode(state.mode, this.#modes) ? state.mode : DEFAULT_MODE;
        const mode = modeOf(name, this.#modes);
        const projectRules = parseRules(
          await tryReadText(store, `${root}/${DEFAULT_SYSTEM_FOLDER}/${PERMISSION_RULES_FILE}`),
        );
        const layers = [
          { source: "deployment", rules: this.#deploymentRules },
          { source: "project", rules: projectRules },
          { source: "user", rules: state?.rules ?? {} },
          this.#registry.sessionLayer(facts.session, facts.user),
        ];
        const definitions = `${root}/${DEFINITIONS_FOLDER}`.toLowerCase();
        return checks.map(([action, path]) =>
          // Outside the project nothing is decided here: the roles and the capability refuse it.
          path !== root && !path.startsWith(`${root}/`)
            ? { verdict: "allow" as const, reason: "outside the project" }
            : // The definitions mount is read-only in every mode: no change there ever asks.
              action !== "read" &&
                action !== "list" &&
                (path.toLowerCase() === definitions ||
                  path.toLowerCase().startsWith(`${definitions}/`))
              ? { verdict: "deny" as const, reason: "the definitions mount is read-only" }
              : // An unattended session has nobody to ask: its asks are denies with a reason
                // (statewalker/statewalker-root#127), and the agent carries on.
                settleAsk(
                  decideMode(
                    {
                      area: "files",
                      action,
                      target: path === root ? "/" : path.slice(root.length),
                    },
                    { mode, layers },
                  ),
                  facts,
                ),
        );
      },
      consume: async (id) => this.#registry.consume(id, facts.session, facts.user),
    };
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
    call: { plugin: string; request: OutgoingRequest },
  ): Promise<GatewayResult> {
    const facts = await this.#authority.agentSessionOf(capability);
    if (!(await this.#access(facts.project, facts.user)).member)
      throw codedError("EACCES", `${facts.user} is not a member of ${facts.project}`);
    const lookup = sessionSecrets(this.#secrets, this.#deploymentSecrets(), facts);
    return gatewayFetch(call.request, String(call.plugin), lookup);
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
