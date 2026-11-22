// A user's User DO (statewalker/statewalker-root#89, amended by #157): one per user per
// deployment. It holds the user's user sessions (one per workspace, opened or resumed by an access
// token and outliving it, holding the mode), and the index of the user's agent sessions across
// workspaces. Opening a user session obtains, from the Workspace DO, a capability narrowed to the
// user; the User DO attenuates it for each agent session it starts. Calls go only from here to a
// workspace: a Workspace DO never calls a User DO.
import {
  type AccessClaims,
  type ApprovalGrant,
  type ApprovalRequest,
  attenuateForAgentSession,
  codedError,
  DEFAULT_MODE,
  isMode,
  type ModeDefinition,
  PERMISSION_RULES_FILE,
  type PermissionRules,
  parseRules,
} from "@statewalker/ai-access";
import type { FilesRpcMethod, ModelsConfig } from "@statewalker/ai-environment";
import { type FilesApi, tryReadText } from "@statewalker/webrun-files";
import type {
  AgentRun,
  AgentSessionConfig,
  AgentSessionView,
  ApprovalAnswer,
  ApprovalView,
  CreatedServiceAccount,
  DatabaseCall,
  DatabaseView,
  DeleteSecretRequest,
  Metadata,
  ModelsQuery,
  ModelView,
  PinnedDefinitions,
  ProfileView,
  SecretScope,
  SecretView,
  ServiceAccountView,
  SetSecretRequest,
  StartSessionRequest,
  SubAgentRequest,
  UserPort,
  UserSessionView,
} from "./api.js";
import type { SqlLike } from "./sql.js";

/** What a User DO asks of one workspace's Workspace DO. */
export interface WorkspaceGrants {
  /** The user capability of the access token's user, signed by the workspace's root key. */
  userCapability(token: string): Promise<string>;
  /** The user's roles in the project now; EACCES for a non-member. */
  memberRoles(userCapability: string, project: string): Promise<string[]>;
  /**
   * Pins the definitions of a new agent session of the user in a project (EACCES for a
   * non-member) and picks its agent: the one asked for, which the user must be allowed (ENOENT
   * otherwise), or the project's default, then the deployment's; and its model, with the user's
   * override (`model`) if any (ENOENT when none fits, EACCES for an override not the user's).
   */
  pinDefinitions(
    userCapability: string,
    req: { session: string; project: string; agent?: string; model?: string },
  ): Promise<PinnedDefinitions>;
  /** A project's models as the user sees them; `discover` asks each provider's `/models`. */
  listModels(userCapability: string, query: ModelsQuery): Promise<ModelView[]>;
  /** The user's own model configuration (user level) there. */
  getModelConfig(userCapability: string): Promise<ModelsConfig>;
  /** Replaces it; EINVAL for a malformed configuration. */
  setModelConfig(userCapability: string, config: unknown): Promise<ModelsConfig>;
  /** Tells the gate the user session's mode and the user's own rules. */
  setUserSession(
    userCapability: string,
    state: { mode: string; rules: PermissionRules },
  ): Promise<void>;
  /** Tells the gate an approval the user granted. */
  grantApproval(userCapability: string, grant: ApprovalGrant): Promise<void>;
  /** One files-RPC call on the file view a capability holds, at the workspace's gate. */
  files(capability: string, method: FilesRpcMethod, args: unknown[]): Promise<unknown>;
  /** A project's databases the user may use there. */
  listDatabases(userCapability: string, project: string): Promise<DatabaseView[]>;
  /** One db-rpc call on a project's database, at the workspace's gate. */
  databaseCall(userCapability: string, call: DatabaseCall): Promise<unknown>;
  /** The secrets of one level the user manages there; EACCES without `secrets.write:<level>`. */
  listSecrets(userCapability: string, scope: SecretScope): Promise<SecretView[]>;
  setSecret(userCapability: string, req: SetSecretRequest): Promise<SecretView>;
  deleteSecret(userCapability: string, req: DeleteSecretRequest): Promise<void>;
  /** Deletes every user-level secret of the user there (the user is being erased). */
  eraseUserSecrets(userCapability: string): Promise<void>;
  /**
   * Puts a capability narrowed from this user capability (or the user capability itself) on the
   * workspace's revocation list: it, and everything narrowed from it, is refused from now on.
   */
  revoke(userCapability: string, capability: string): Promise<void>;
  /**
   * Narrows an agent session's capability (narrowed from this user capability) for a sub-agent,
   * with a block the workspace signs (statewalker/statewalker-root#126).
   */
  delegate(
    userCapability: string,
    parentCapability: string,
    grant: { session: string; agent: string; mode?: string },
  ): Promise<{ capability: string; agent: string; run?: AgentRun; model?: string }>;
  /** The workspace's service accounts; EACCES unless the user is a workspace admin. */
  listServiceAccounts(userCapability: string): Promise<ServiceAccountView[]>;
  createServiceAccount(userCapability: string, name: string): Promise<CreatedServiceAccount>;
  deleteServiceAccount(userCapability: string, name: string): Promise<void>;
}

export interface UserSessionsOptions {
  sql: SqlLike;
  /** The one user this User DO serves. */
  user: string;
  /** The user's profile: their own folder of the deployment's profiles file system, as its root. */
  profile: FilesApi;
  /** Erases the user's profile folder. */
  eraseProfile(): Promise<void>;
  /** Erases the User DO's whole storage. */
  eraseStorage(): Promise<void>;
  /** The claims of a valid access token for a workspace the deployment serves; EAUTH otherwise. */
  verifyToken(token: string): Promise<AccessClaims>;
  /** The Workspace DO of a workspace. */
  workspace(name: string): WorkspaceGrants;
  /** The deployment's own modes, beside the built-in ones. */
  modes?: Readonly<Record<string, ModeDefinition>>;
  /** How long a pending approval waits before it counts as denied. */
  approvalTtlMs: number;
  /** The clock (tests). */
  now?: () => number;
}

export { DEFAULT_MODE };

interface ApprovalRow {
  id: string;
  workspace: string;
  session: string;
  project: string;
  request: string;
  status: string;
  created: number;
  expires: number;
}

interface UserSessionRow {
  workspace: string;
  id: string;
  mode: string;
  capability: string;
  created: number;
}

interface AgentRow {
  id: string;
  workspace: string;
  project: string;
  agent: string;
  created: number;
  /** The agent session's capability, kept so the user can revoke it. */
  capability: string | null;
  unattended: number;
  revoked: number;
  /** A sub-agent's parent and root sessions (statewalker/statewalker-root#126). */
  parent: string | null;
  root: string | null;
}

interface AgentMetaRow {
  metadata: string | null;
  archived: number | null;
}

const view = (row: AgentRow & Partial<AgentMetaRow>): AgentSessionView => ({
  id: row.id,
  workspace: row.workspace,
  project: row.project,
  agent: row.agent,
  created: Number(row.created),
  unattended: Boolean(row.unattended),
  revoked: Boolean(row.revoked),
  metadata: row.metadata ? (JSON.parse(row.metadata) as Metadata) : {},
  ...(row.archived ? { archived: Number(row.archived) } : {}),
  ...(row.parent ? { parent: row.parent, root: String(row.root) } : {}),
});

/** The session index with each session's metadata and archive time (a table of its own). */
const INDEX = `SELECT a.*, m.metadata, m.archived FROM agent_sessions a
  LEFT JOIN agent_session_meta m ON m.id = a.id`;

export class UserSessions implements UserPort {
  readonly #o: UserSessionsOptions;

  constructor(options: UserSessionsOptions) {
    this.#o = options;
    this.createTables();
  }

  /** Creates the User DO's tables (again, after its storage was erased). */
  createTables(): void {
    this.#o.sql.exec(`CREATE TABLE IF NOT EXISTS user_sessions (
      workspace TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, mode TEXT NOT NULL,
      capability TEXT NOT NULL, created INTEGER NOT NULL)`);
    this.#o.sql.exec(`CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY, workspace TEXT NOT NULL, project TEXT NOT NULL, agent TEXT NOT NULL,
      created INTEGER NOT NULL)`);
    // Added by statewalker/statewalker-root#127; a User DO made before it gets the columns here.
    const columns = new Set(
      this.#o.sql
        .exec("SELECT name FROM pragma_table_info('agent_sessions')")
        .toArray()
        .map((r) => String((r as { name: unknown }).name)),
    );
    for (const [name, type] of [
      ["capability", "TEXT"],
      ["unattended", "INTEGER NOT NULL DEFAULT 0"],
      ["revoked", "INTEGER NOT NULL DEFAULT 0"],
      // statewalker/statewalker-root#126: the tree of sub-agents.
      ["parent", "TEXT"],
      ["root", "TEXT"],
    ] as const)
      if (!columns.has(name))
        this.#o.sql.exec(`ALTER TABLE agent_sessions ADD COLUMN ${name} ${type}`);
    // One row per approval (keyed by the action, so per session): a retried identical action
    // reopens the same row once it was answered or expired.
    this.#o.sql.exec(`CREATE TABLE IF NOT EXISTS approvals (
      id TEXT NOT NULL, workspace TEXT NOT NULL, session TEXT NOT NULL, project TEXT NOT NULL,
      request TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL,
      expires INTEGER NOT NULL, PRIMARY KEY (workspace, id))`);
    // statewalker/statewalker-root#125: metadata and archiving, beside the index.
    this.#o.sql.exec(`CREATE TABLE IF NOT EXISTS agent_session_meta (
      id TEXT PRIMARY KEY, metadata TEXT NOT NULL, archived INTEGER)`);
  }

  #now(): number {
    return this.#o.now?.() ?? Date.now();
  }

  #approvalView(row: ApprovalRow): ApprovalView {
    const expired = row.status === "pending" && Number(row.expires) <= this.#now();
    return {
      ...(JSON.parse(row.request) as ApprovalRequest),
      workspace: row.workspace,
      status: expired ? "expired" : (row.status as ApprovalView["status"]),
      created: Number(row.created),
      expires: Number(row.expires),
    };
  }

  #approvals(workspace: string): ApprovalView[] {
    const rows = this.#o.sql
      .exec("SELECT * FROM approvals WHERE workspace = ? ORDER BY created, rowid", workspace)
      .toArray() as unknown as ApprovalRow[];
    return rows.map((r) => this.#approvalView(r));
  }

  /** The user's own rules, from their profile (none when it holds none). */
  async #userRules(): Promise<PermissionRules> {
    return parseRules(await tryReadText(this.#o.profile, `/${PERMISSION_RULES_FILE}`));
  }

  /** Tells the workspace's gate the user session's mode and the user's rules, as they are now. */
  async #pushUserSession(us: UserSessionRow, mode = us.mode): Promise<void> {
    await this.#o
      .workspace(us.workspace)
      .setUserSession(us.capability, { mode, rules: await this.#userRules() });
  }

  #one<T>(query: string, ...args: unknown[]): T | undefined {
    return this.#o.sql.exec(query, ...args).toArray()[0] as T | undefined;
  }

  /** The claims of the token, which must name this User DO's user. */
  async claims(token: string): Promise<AccessClaims> {
    const claims = await this.#o.verifyToken(token);
    if (claims.user !== this.#o.user)
      throw codedError("EAUTH", "the access token is for another user");
    return claims;
  }

  async #userSession(token: string): Promise<UserSessionRow> {
    const { workspace } = await this.claims(token);
    const row = this.#one<UserSessionRow>(
      "SELECT * FROM user_sessions WHERE workspace = ?",
      workspace,
    );
    if (row) return row;
    const capability = await this.#o.workspace(workspace).userCapability(token);
    const created: UserSessionRow = {
      workspace,
      id: `us-${crypto.randomUUID()}`,
      mode: DEFAULT_MODE,
      capability,
      created: Date.now(),
    };
    // Another call may have opened it meanwhile: the first one stays.
    this.#o.sql.exec(
      "INSERT OR IGNORE INTO user_sessions VALUES (?, ?, ?, ?, ?)",
      created.workspace,
      created.id,
      created.mode,
      created.capability,
      created.created,
    );
    return this.#one<UserSessionRow>(
      "SELECT * FROM user_sessions WHERE workspace = ?",
      workspace,
    ) as UserSessionRow;
  }

  #userSessionView(row: UserSessionRow): UserSessionView {
    return {
      id: row.id,
      user: this.#o.user,
      workspace: row.workspace,
      mode: row.mode,
      created: Number(row.created),
      approvals: this.#approvals(row.workspace).filter((a) => a.status === "pending"),
    };
  }

  async openUserSession(token: string): Promise<UserSessionView> {
    return this.#userSessionView(await this.#userSession(token));
  }

  /**
   * Switches the user session's mode. The gate is told first, so running agent sessions follow at
   * their next action; only the user's own token reaches here.
   */
  async setMode(token: string, mode: string): Promise<UserSessionView> {
    if (!isMode(mode, this.#o.modes)) throw codedError("EINVAL", `no mode '${mode}'`);
    const us = await this.#userSession(token);
    await this.#pushUserSession(us, mode);
    this.#o.sql.exec("UPDATE user_sessions SET mode = ? WHERE workspace = ?", mode, us.workspace);
    return this.#userSessionView({ ...us, mode });
  }

  /**
   * Records the approvals a waiting turn of one of this user's agent sessions waits on. Told by
   * the agent session's DO (an agent session → user call; a Workspace DO never calls here), for a
   * session in this user's index only.
   */
  async recordApprovals(session: string, requests: ApprovalRequest[]): Promise<ApprovalView[]> {
    const row = this.#one<AgentRow>("SELECT * FROM agent_sessions WHERE id = ?", String(session));
    if (!row) throw codedError("ENOENT", "no such agent session");
    const own = view(row);
    const now = this.#now();
    const out: ApprovalView[] = [];
    for (const request of requests) {
      if (request.session !== own.id || request.project !== own.project)
        throw codedError("EINVAL", "an approval of another session");
      const row = this.#one<ApprovalRow>(
        "SELECT * FROM approvals WHERE workspace = ? AND id = ?",
        own.workspace,
        request.id,
      );
      // A retried identical action waits on the same approval while it is pending.
      if (row?.status !== "pending" || Number(row.expires) <= now)
        this.#o.sql.exec(
          "INSERT OR REPLACE INTO approvals VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
          request.id,
          own.workspace,
          own.id,
          own.project,
          JSON.stringify(request),
          now,
          now + this.#o.approvalTtlMs,
        );
      out.push(
        this.#approvalView(
          this.#one<ApprovalRow>(
            "SELECT * FROM approvals WHERE workspace = ? AND id = ?",
            own.workspace,
            request.id,
          ) as ApprovalRow,
        ),
      );
    }
    return out;
  }

  async listApprovals(token: string): Promise<{ approvals: ApprovalView[] }> {
    const { workspace } = await this.claims(token);
    return { approvals: this.#approvals(workspace) };
  }

  /**
   * Answers one of the caller's pending approvals. An allow is granted at the gate (with the
   * user capability), which re-checks it against the mode and roles when the action runs.
   */
  async answerApproval(token: string, id: string, answer: ApprovalAnswer): Promise<ApprovalView> {
    const us = await this.#userSession(token);
    const row = this.#one<ApprovalRow>(
      "SELECT * FROM approvals WHERE workspace = ? AND id = ?",
      us.workspace,
      id,
    );
    if (!row) throw codedError("ENOENT", "no such approval");
    const current = this.#approvalView(row);
    if (current.status === "expired") throw codedError("EINVAL", "the approval expired");
    if (current.status !== "pending") throw codedError("EINVAL", "the approval was answered");
    const status = answer.decision === "allow" ? "allowed" : "denied";
    if (status === "allowed")
      await this.#o.workspace(us.workspace).grantApproval(us.capability, {
        id,
        session: current.session,
        scope: answer.scope,
        permission: current.permission,
        expires: current.expires,
      });
    this.#o.sql.exec(
      "UPDATE approvals SET status = ? WHERE workspace = ? AND id = ? AND status = 'pending'",
      status,
      us.workspace,
      id,
    );
    return { ...current, status };
  }

  async startAgentSession(
    token: string,
    req: StartSessionRequest,
  ): Promise<{ session: AgentSessionView; config: AgentSessionConfig }> {
    const us = await this.#userSession(token);
    const id = `as-${crypto.randomUUID()}`;
    // Membership, the agent and the session's definitions, decided and pinned by the workspace.
    const pinned = await this.#o.workspace(us.workspace).pinDefinitions(us.capability, {
      session: id,
      project: req.project,
      ...(req.agent ? { agent: req.agent } : {}),
      ...(req.model ? { model: req.model } : {}),
    });
    const capability = attenuateForAgentSession(us.capability, {
      session: id,
      project: req.project,
      agent: pinned.agent,
      unattended: req.unattended === true,
    });
    const row: AgentRow = {
      id,
      workspace: us.workspace,
      project: req.project,
      agent: pinned.agent,
      created: Date.now(),
      capability,
      unattended: req.unattended ? 1 : 0,
      revoked: 0,
      parent: null,
      root: null,
    };
    // The gate decides every action by the user session's current mode, so it is told now.
    await this.#pushUserSession(us);
    this.#o.sql.exec(
      `INSERT INTO agent_sessions (id, workspace, project, agent, created, capability, unattended,
        revoked) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.workspace,
      row.project,
      row.agent,
      row.created,
      row.capability,
      row.unattended,
      row.revoked,
    );
    const metadata = req.metadata ?? {};
    this.#o.sql.exec(
      "INSERT INTO agent_session_meta VALUES (?, ?, NULL)",
      row.id,
      JSON.stringify(metadata),
    );
    return {
      session: view({ ...row, metadata: JSON.stringify(metadata), archived: null }),
      config: {
        id: row.id,
        user: this.#o.user,
        workspace: row.workspace,
        project: row.project,
        agent: row.agent,
        capability,
        ...(pinned.run ? { run: pinned.run } : {}),
        ...(pinned.model ? { model: pinned.model } : {}),
      },
    };
  }

  /**
   * Starts a sub-agent of one of this user's agent sessions (the harness tool `agent.start`,
   * statewalker/statewalker-root#126). Told by the parent's DO, which proves it is the parent by
   * the capability it holds; no access token is needed, so a tree keeps growing after the user's
   * token expired. The workspace narrows the parent's capability for the child, so the child can do
   * nothing its parent can't, and revoking the parent stops it.
   */
  async startSubAgent(
    parentId: string,
    parentCapability: string,
    req: SubAgentRequest,
  ): Promise<{ session: AgentSessionView; config: AgentSessionConfig }> {
    const parent = this.#one<AgentRow & AgentMetaRow>(`${INDEX} WHERE a.id = ?`, String(parentId));
    if (!parent?.capability || parent.capability !== parentCapability)
      throw codedError("EACCES", "not an agent session of this user");
    if (parent.revoked || parent.archived)
      throw codedError("EACCES", "the agent session is revoked");
    const us = this.#one<UserSessionRow>(
      "SELECT * FROM user_sessions WHERE workspace = ?",
      parent.workspace,
    );
    if (!us) throw codedError("EACCES", "the user session is revoked");
    if (req.mode !== undefined && !isMode(req.mode, this.#o.modes))
      throw codedError("EINVAL", `no mode '${req.mode}'`);
    const id = `as-${crypto.randomUUID()}`;
    // The workspace checks the agent against the parent's definition and the user's roles, pins
    // the child's definitions and narrows the parent's capability for it.
    const { capability, agent, run, model } = await this.#o
      .workspace(us.workspace)
      .delegate(us.capability, parentCapability, {
        session: id,
        agent: req.agent,
        ...(req.mode ? { mode: req.mode } : {}),
      });
    // The parent may have been archived or revoked while the workspace worked: a child joining
    // the tree now would be missed by that archive, so it is refused.
    const now = this.#one<AgentRow & AgentMetaRow>(`${INDEX} WHERE a.id = ?`, parent.id);
    if (!now || now.revoked || now.archived)
      throw codedError("EACCES", "the agent session is revoked");
    const row: AgentRow = {
      id,
      workspace: parent.workspace,
      project: parent.project,
      agent,
      created: Date.now(),
      capability,
      unattended: parent.unattended,
      revoked: 0,
      parent: parent.id,
      root: parent.root ?? parent.id,
    };
    this.#o.sql.exec(
      `INSERT INTO agent_sessions (id, workspace, project, agent, created, capability, unattended,
        revoked, parent, root) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.workspace,
      row.project,
      row.agent,
      row.created,
      row.capability,
      row.unattended,
      row.revoked,
      row.parent,
      row.root,
    );
    this.#o.sql.exec("INSERT INTO agent_session_meta VALUES (?, '{}', NULL)", row.id);
    return {
      session: view({ ...row, metadata: "{}", archived: null }),
      config: {
        id: row.id,
        user: this.#o.user,
        workspace: row.workspace,
        project: row.project,
        agent: row.agent,
        capability,
        parent: String(row.parent),
        root: String(row.root),
        ...(run ? { run } : {}),
        ...(model ? { model } : {}),
        ...(req.tools ? { tools: [...req.tools] } : {}),
        ...(req.mode ? { mode: req.mode } : {}),
      },
    };
  }

  async ownAgentSession(token: string, id: string): Promise<AgentSessionView> {
    const { workspace } = await this.claims(token);
    const row = this.#one<AgentRow & AgentMetaRow>(
      `${INDEX} WHERE a.id = ? AND a.workspace = ?`,
      id,
      workspace,
    );
    if (!row) throw codedError("ENOENT", "no such agent session");
    return view(row);
  }

  async updateAgentSession(token: string, id: string, metadata: Metadata) {
    const own = await this.ownAgentSession(token, id);
    this.#o.sql.exec(
      `INSERT INTO agent_session_meta VALUES (?, ?, NULL)
        ON CONFLICT (id) DO UPDATE SET metadata = excluded.metadata`,
      own.id,
      JSON.stringify(metadata),
    );
    return this.ownAgentSession(token, id);
  }

  /** A session and its descendants (sub-agents, theirs, …), the session first. */
  #tree(id: string): string[] {
    return this.#o.sql
      .exec(
        `WITH RECURSIVE tree(id) AS (SELECT ? UNION SELECT a.id FROM agent_sessions a
          JOIN tree ON a.parent = tree.id) SELECT id FROM tree`,
        id,
      )
      .toArray()
      .map((r) => String((r as { id: unknown }).id));
  }

  /** One of the caller's agent sessions and its descendants, the session first. */
  async subtree(token: string, id: string): Promise<string[]> {
    const own = await this.ownAgentSession(token, id);
    return this.#tree(own.id);
  }

  /**
   * Revokes a session's capability at the workspace (which stops every capability narrowed from
   * it: its sub-agents' too), and marks it and its descendants revoked.
   */
  async #revokeTree(us: UserSessionRow, row: AgentRow): Promise<void> {
    // A session recorded before capabilities were kept has none to name (and no sub-agents):
    // it is never marked revoked while the gate would still accept it.
    if (!row.capability) return;
    if (!row.revoked) await this.#o.workspace(us.workspace).revoke(us.capability, row.capability);
    for (const id of this.#tree(row.id))
      this.#o.sql.exec("UPDATE agent_sessions SET revoked = 1 WHERE id = ?", id);
  }

  /**
   * Archives one of the caller's agent sessions and its descendants (statewalker/statewalker-root#126):
   * the session's capability is revoked, so the gate refuses it and every sub-agent's narrowed
   * from it at their next operation; its siblings keep running.
   */
  async archiveAgentSession(token: string, id: string) {
    const us = await this.#userSession(token);
    const own = await this.ownAgentSession(token, id);
    const row = this.#one<AgentRow>(
      "SELECT * FROM agent_sessions WHERE id = ?",
      own.id,
    ) as AgentRow;
    await this.#revokeTree(us, row);
    const now = Date.now();
    for (const sid of this.#tree(own.id))
      this.#o.sql.exec(
        `INSERT INTO agent_session_meta VALUES (?, '{}', ?)
          ON CONFLICT (id) DO UPDATE SET archived = COALESCE(agent_session_meta.archived, excluded.archived)`,
        sid,
        now,
      );
    return this.ownAgentSession(token, id);
  }

  async deleteAgentSession(token: string, id: string): Promise<void> {
    const own = await this.ownAgentSession(token, id);
    this.#o.sql.exec("DELETE FROM agent_session_meta WHERE id = ?", own.id);
    this.#o.sql.exec("DELETE FROM agent_sessions WHERE id = ?", own.id);
  }

  /** The caller's profile: the projects it holds user memory of (preferences: a later ticket). */
  async profile(token: string): Promise<ProfileView> {
    await this.claims(token);
    const projects: ProfileView["projects"] = [];
    for await (const ws of this.#o.profile.list("/projects"))
      if (ws.kind === "directory")
        for await (const p of this.#o.profile.list(ws.path))
          if (p.kind === "directory") projects.push({ workspace: ws.name, project: p.name });
    projects.sort((a, b) =>
      a.workspace === b.workspace
        ? a.project.localeCompare(b.project)
        : a.workspace.localeCompare(b.workspace),
    );
    return { user: this.#o.user, projects };
  }

  /**
   * Erases the caller: their profile, then the User DO's storage (user sessions and the session
   * index). A later token starts afresh.
   */
  async eraseUser(token: string): Promise<{ erased: true }> {
    await this.claims(token);
    // The user's own secrets live in each workspace's DO: erased there first, through each user
    // session's capability.
    const sessions = this.#o.sql
      .exec("SELECT * FROM user_sessions")
      .toArray() as unknown as UserSessionRow[];
    // Their user sessions are revoked there too, so no agent session they started acts on.
    for (const us of sessions) {
      await this.#o.workspace(us.workspace).eraseUserSecrets(us.capability);
      await this.#o.workspace(us.workspace).revoke(us.capability, us.capability);
    }
    await this.#o.eraseProfile();
    await this.#o.eraseStorage();
    this.createTables();
    return { erased: true };
  }

  /**
   * One files-RPC call on the user's own file view of the token's workspace: the gate decides it
   * with the user capability of their user session (no ignore rules apply to it).
   */
  async files(token: string, method: FilesRpcMethod, args: unknown[]): Promise<unknown> {
    const us = await this.#userSession(token);
    return this.#o.workspace(us.workspace).files(us.capability, method, args);
  }

  /** A project's databases the user may use, as the workspace's gate answers them. */
  async listDatabases(token: string, project: string): Promise<{ databases: DatabaseView[] }> {
    const us = await this.#userSession(token);
    return {
      databases: await this.#o.workspace(us.workspace).listDatabases(us.capability, project),
    };
  }

  /** One db-rpc call on a project's database, with the user capability of their user session. */
  async databaseCall(token: string, call: DatabaseCall): Promise<unknown> {
    const us = await this.#userSession(token);
    return this.#o.workspace(us.workspace).databaseCall(us.capability, call);
  }

  async listSecrets(token: string, scope: SecretScope): Promise<{ secrets: SecretView[] }> {
    const us = await this.#userSession(token);
    return { secrets: await this.#o.workspace(us.workspace).listSecrets(us.capability, scope) };
  }

  async setSecret(token: string, req: SetSecretRequest): Promise<SecretView> {
    const us = await this.#userSession(token);
    return this.#o.workspace(us.workspace).setSecret(us.capability, req);
  }

  async deleteSecret(token: string, req: DeleteSecretRequest): Promise<{ deleted: true }> {
    const us = await this.#userSession(token);
    await this.#o.workspace(us.workspace).deleteSecret(us.capability, req);
    return { deleted: true };
  }

  /**
   * Revokes one of the user's agent sessions in the token's workspace: the workspace puts its
   * capability on its revocation list, so the gate refuses it (and every capability narrowed from
   * it) at its next operation, and the User DO sends it no more messages.
   */
  async revokeAgentSession(token: string, id: string): Promise<{ revoked: true }> {
    const us = await this.#userSession(token);
    const row = this.#one<AgentRow>(
      "SELECT * FROM agent_sessions WHERE id = ? AND workspace = ?",
      id,
      us.workspace,
    );
    if (!row) throw codedError("ENOENT", "no such agent session");
    // A session recorded before its capability was kept cannot be named on the revocation list
    // alone; answering "revoked" while the gate still accepts it would be a lie.
    if (!row.revoked && !row.capability)
      throw codedError(
        "EINVAL",
        "this agent session predates per-session revocation: revoke the user session instead",
      );
    // Its sub-agents' capabilities are narrowed from its own: they stop with it.
    await this.#revokeTree(us, row);
    return { revoked: true };
  }

  /**
   * Revokes the user session of the token's workspace: its capability goes on the workspace's
   * revocation list, so every agent session narrowed from it stops at its next operation. The next
   * call opens a new user session, with a new capability.
   */
  async revokeUserSession(token: string): Promise<{ revoked: true }> {
    const { workspace } = await this.claims(token);
    const us = this.#one<UserSessionRow>(
      "SELECT * FROM user_sessions WHERE workspace = ?",
      workspace,
    );
    if (us) await this.#o.workspace(workspace).revoke(us.capability, us.capability);
    this.#o.sql.exec("UPDATE agent_sessions SET revoked = 1 WHERE workspace = ?", workspace);
    this.#o.sql.exec("DELETE FROM user_sessions WHERE workspace = ?", workspace);
    return { revoked: true };
  }

  async listServiceAccounts(token: string): Promise<{ accounts: ServiceAccountView[] }> {
    const us = await this.#userSession(token);
    return { accounts: await this.#o.workspace(us.workspace).listServiceAccounts(us.capability) };
  }

  async createServiceAccount(token: string, name: string): Promise<CreatedServiceAccount> {
    const us = await this.#userSession(token);
    return this.#o.workspace(us.workspace).createServiceAccount(us.capability, name);
  }

  async deleteServiceAccount(token: string, name: string): Promise<{ deleted: true }> {
    const us = await this.#userSession(token);
    await this.#o.workspace(us.workspace).deleteServiceAccount(us.capability, name);
    return { deleted: true };
  }

  async listModels(token: string, query: ModelsQuery): Promise<{ models: ModelView[] }> {
    const us = await this.#userSession(token);
    return { models: await this.#o.workspace(us.workspace).listModels(us.capability, query) };
  }

  async getModelConfig(token: string): Promise<ModelsConfig> {
    const us = await this.#userSession(token);
    return this.#o.workspace(us.workspace).getModelConfig(us.capability);
  }

  async setModelConfig(token: string, config: unknown): Promise<ModelsConfig> {
    const us = await this.#userSession(token);
    return this.#o.workspace(us.workspace).setModelConfig(us.capability, config);
  }

  async listAgentSessions(token: string): Promise<{ sessions: AgentSessionView[] }> {
    const { workspace } = await this.claims(token);
    const rows = this.#o.sql
      .exec(`${INDEX} WHERE a.workspace = ? ORDER BY a.created, a.rowid`, workspace)
      .toArray() as unknown as (AgentRow & AgentMetaRow)[];
    return { sessions: rows.map(view) };
  }
}
