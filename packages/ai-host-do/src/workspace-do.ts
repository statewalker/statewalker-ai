// One Workspace DO per workspace: the store (from the deployment's configuration), the role sources (each project's access file and the
// workspace's SQL, as the deployment's ROLE_SOURCES var chains them), the
// workspace's root key (it never leaves this DO), and the gate every file call of every agent
// session goes through. Its name is the workspace. It mints a user capability for a user session
// that a User DO opens with the user's access token, and the gate reads user, project and session
// from each call's capability: it never calls a User DO (statewalker/statewalker-root#157).

import { DurableObject } from "cloudflare:workers";
import {
  accessOf,
  chainRoleSources,
  codedError,
  DEFAULT_SYSTEM_FOLDER,
  decide,
  fileRoleSource,
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
  deploymentSecrets,
  FilesRpcHost,
  type FilesRpcMethod,
  type GatedFilesOptions,
  type GatewayResult,
  gatedFilesRpc,
  gatewayFetch,
  IGNORE_FILE,
  ignoreRules,
  normalise,
  type OutgoingRequest,
  type SecretInfo,
  SecretStore,
  type StoredLevel,
  sessionSecrets,
} from "@statewalker/ai-environment";
import type {
  CreatedServiceAccount,
  DeleteSecretRequest,
  SecretScope,
  SecretView,
  ServiceAccountView,
  SetSecretRequest,
} from "@statewalker/ai-sessions";
import { type FilesApi, tryReadText } from "@statewalker/webrun-files";
import { blockSizeOf, type Env, issuerOf, nameOf, verifyToken } from "./env.js";
import { mountWorkspace } from "./workspace-store.js";

export class Workspace extends DurableObject<Env> {
  readonly #name: string;
  readonly #store: Promise<FilesApi>;
  /** One files-RPC server per capability that holds a file view, so streams live across calls. */
  readonly #files: FilesRpcHost;
  readonly #authority: WorkspaceAuthority;
  readonly #sqlRoles: SqlRoleSource;
  readonly #roles: RoleSource;
  readonly #secrets: SecretStore;

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

  /** Whether a user sees a project: membership, from the role sources now. */
  async #member(project: string, user: string): Promise<boolean> {
    try {
      return (await this.#access(project, user)).member;
    } catch {
      return false;
    }
  }

  /**
   * The gated view a capability holds, as a files-RPC endpoint. An agent session's capability sees
   * its project, with the ignore rules applied; the user capability of a user session sees every
   * project the user is a member of, without them. Membership and roles are read from the role
   * sources at every action, never fixed when the view opens, so a demotion or removal reaches the
   * next call and the next block of a stream.
   */
  async #fileView(capability: string) {
    const store = await this.#store;
    const agent = await this.#authority.agentSessionOf(capability).catch(() => undefined);
    const user = agent?.user ?? (await this.#authority.userOfUserCapability(capability));
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
    return gatedFilesRpc(store, options);
  }

  /**
   * The gate: one files-RPC call on the file view a capability holds (an agent session's, or a
   * user session's own), decided now. User, project and session come from the capability itself;
   * a capability this workspace did not sign is refused (EACCES).
   */
  async files(capability: string, method: FilesRpcMethod, args: unknown[]): Promise<unknown> {
    return this.#files.call(capability, method, args);
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
