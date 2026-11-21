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
  fileRoleSource,
  type RoleEntries,
  type RoleSource,
  SqlRoleSource,
  type StoredRootKey,
  WorkspaceAuthority,
} from "@statewalker/ai-access";
import {
  FilesRpcHost,
  type FilesRpcMethod,
  type GatedFilesOptions,
  gatedFilesRpc,
  IGNORE_FILE,
  ignoreRules,
  normalise,
} from "@statewalker/ai-environment";
import { type FilesApi, tryReadText } from "@statewalker/webrun-files";
import { blockSizeOf, type Env, nameOf, verifyToken } from "./env.js";
import { mountWorkspace } from "./workspace-store.js";

export class Workspace extends DurableObject<Env> {
  readonly #name: string;
  readonly #store: Promise<FilesApi>;
  /** One files-RPC server per capability that holds a file view, so streams live across calls. */
  readonly #files: FilesRpcHost;
  readonly #authority: WorkspaceAuthority;
  readonly #sqlRoles: SqlRoleSource;
  readonly #roles: RoleSource;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#name = nameOf(ctx);
    const sql = ctx.storage.sql;
    this.#store = mountWorkspace(env, ctx.storage, this.#name);
    this.#store.catch(() => {});
    this.#files = new FilesRpcHost((capability) => this.#view(capability));
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
  async #view(capability: string) {
    const store = await this.#store;
    const agent = await this.#authority.agentSessionOf(capability).catch(() => undefined);
    const user = agent?.user ?? (await this.#authority.userOf(capability));
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
