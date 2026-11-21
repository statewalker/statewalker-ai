// One Workspace DO per workspace: the store, the role sources (each project's access file and the
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
  accessOf,
  approvalId,
  chainRoleSources,
  codedError,
  DEFAULT_MODE,
  DEFAULT_SYSTEM_FOLDER,
  decide,
  decideMode,
  type FileAction,
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
  WORKSPACE_ROLES,
  WorkspaceAuthority,
} from "@statewalker/ai-access";
import {
  answerFileCall,
  deploymentSecrets,
  type FileCall,
  type FileOp,
  type GatewayResult,
  gatedFiles,
  gatewayFetch,
  normalise,
  type OutgoingRequest,
  type SecretInfo,
  SecretStore,
  SqlFiles,
  type StoredLevel,
  sessionSecrets,
} from "@statewalker/ai-environment";
import type {
  DeleteSecretRequest,
  SecretScope,
  SecretView,
  SetSecretRequest,
} from "@statewalker/ai-sessions";
import { tryReadText } from "@statewalker/webrun-files";
import { deploymentModes, deploymentRules, type Env, nameOf, verifyToken } from "./env.js";

/** Thrown inside the gate when the mode or a rule asks; the call answers with the request. */
class NeedsApproval extends Error {
  constructor(readonly request: ApprovalRequest) {
    super(`needs approval ${request.id}`);
  }
}

export class Workspace extends DurableObject<Env> {
  readonly #name: string;
  readonly #store: SqlFiles;
  readonly #authority: WorkspaceAuthority;
  readonly #sqlRoles: SqlRoleSource;
  readonly #roles: RoleSource;
  readonly #registry: ApprovalRegistry;
  readonly #modes: Record<string, ModeDefinition>;
  readonly #deploymentRules: PermissionRules;
  readonly #secrets: SecretStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#name = nameOf(ctx);
    const sql = ctx.storage.sql;
    this.#store = new SqlFiles(sql);
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
    this.#authority = WorkspaceAuthority.fromStored(root);
    this.#sqlRoles = new SqlRoleSource(sql);
    const files = fileRoleSource((path) => tryReadText(this.#store, path), DEFAULT_SYSTEM_FOLDER);
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

  /**
   * The gate: one file call of the agent session the capability names, decided now. User and
   * project come from the capability itself; the user's roles are read from the role sources at
   * this moment, never fixed at the session's start, so a demotion reaches the next call. Then
   * the permission rules of the deployment, the project, the user and the agent session, and the
   * user session's current mode decide (statewalker/statewalker-root#124): a mode switch reaches
   * the next call too. A call the mode asks about answers `{$approval}` unless the user granted
   * that exact action.
   */
  async fileCall(capability: string, call: FileCall): Promise<unknown> {
    const facts = await this.#authority.agentSessionOf(capability);
    const { grants } = await this.#access(facts.project, facts.user);
    const view = gatedFiles(this.#store, {
      project: facts.project,
      systemFolder: DEFAULT_SYSTEM_FOLDER,
      authorize: async (action, path, op) => {
        await this.#authority.authorize(capability, {
          action,
          path,
          project: facts.project,
          grants,
        });
        await this.#decide(facts, action, path, op);
      },
    });
    try {
      return await answerFileCall(view, call);
    } catch (e) {
      if (e instanceof NeedsApproval) return { $approval: e.request };
      throw e;
    }
  }

  /** The mode and the rules on an action the roles allow: allowed, EACCES, or NeedsApproval. */
  async #decide(
    facts: AgentSessionFacts,
    action: FileAction,
    path: string,
    op: FileOp,
  ): Promise<void> {
    const state = this.#registry.userSession(facts.user);
    const modeName = state && isMode(state.mode, this.#modes) ? state.mode : DEFAULT_MODE;
    const mode = modeOf(modeName, this.#modes);
    const root = `/${facts.project}`;
    const target = path === root ? "/" : path.slice(root.length);
    const projectRules = parseRules(
      await tryReadText(this.#store, `${root}/${DEFAULT_SYSTEM_FOLDER}/${PERMISSION_RULES_FILE}`),
    );
    const decision = decideMode(
      { area: "files", action, target },
      {
        mode,
        layers: [
          { source: "deployment", rules: this.#deploymentRules },
          { source: "project", rules: projectRules },
          { source: "user", rules: state?.rules ?? {} },
          { source: "session", rules: this.#registry.sessionRules(facts.session, facts.user) },
        ],
      },
    );
    if (decision.verdict === "allow") return;
    if (decision.verdict === "deny")
      throw codedError("EACCES", `may not ${action} '${path}': ${decision.reason}`);
    const id = await approvalId(facts.session, op.method, path, op.content);
    if (this.#registry.consume(id, facts.session, facts.user)) return;
    throw new NeedsApproval({
      id,
      session: facts.session,
      project: facts.project,
      action: {
        method: op.method,
        path,
        ...(op.content ? { size: op.content.length } : {}),
      },
      permission: `files.${action}:${target}`,
      reason: decision.reason,
    });
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
    for (const [path, text] of Object.entries(files))
      await this.#store.write(normalise(path), [enc.encode(text)]);
    return Object.keys(files).length;
  }
}
