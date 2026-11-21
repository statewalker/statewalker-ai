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
import type { FilesRpcMethod } from "@statewalker/ai-environment";
import { type FilesApi, tryReadText } from "@statewalker/webrun-files";
import type {
  AgentSessionConfig,
  AgentSessionView,
  ApprovalAnswer,
  ApprovalView,
  DeleteSecretRequest,
  Metadata,
  PinnedDefinitions,
  ProfileView,
  SecretScope,
  SecretView,
  SetSecretRequest,
  StartSessionRequest,
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
   * otherwise), or the project's default, then the deployment's.
   */
  pinDefinitions(
    userCapability: string,
    req: { session: string; project: string; agent?: string },
  ): Promise<PinnedDefinitions>;
  /** Tells the gate the user session's mode and the user's own rules. */
  setUserSession(
    userCapability: string,
    state: { mode: string; rules: PermissionRules },
  ): Promise<void>;
  /** Tells the gate an approval the user granted. */
  grantApproval(userCapability: string, grant: ApprovalGrant): Promise<void>;
  /** One files-RPC call on the file view a capability holds, at the workspace's gate. */
  files(capability: string, method: FilesRpcMethod, args: unknown[]): Promise<unknown>;
  /** The secrets of one level the user manages there; EACCES without `secrets.write:<level>`. */
  listSecrets(userCapability: string, scope: SecretScope): Promise<SecretView[]>;
  setSecret(userCapability: string, req: SetSecretRequest): Promise<SecretView>;
  deleteSecret(userCapability: string, req: DeleteSecretRequest): Promise<void>;
  /** Deletes every user-level secret of the user there (the user is being erased). */
  eraseUserSecrets(userCapability: string): Promise<void>;
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
  metadata: row.metadata ? (JSON.parse(row.metadata) as Metadata) : {},
  ...(row.archived ? { archived: Number(row.archived) } : {}),
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
    });
    const row: AgentRow = {
      id,
      workspace: us.workspace,
      project: req.project,
      agent: pinned.agent,
      created: Date.now(),
    };
    const capability = attenuateForAgentSession(us.capability, {
      session: row.id,
      project: row.project,
      agent: row.agent,
    });
    // The gate decides every action by the user session's current mode, so it is told now.
    await this.#pushUserSession(us);
    this.#o.sql.exec(
      "INSERT INTO agent_sessions VALUES (?, ?, ?, ?, ?)",
      row.id,
      row.workspace,
      row.project,
      row.agent,
      row.created,
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

  async archiveAgentSession(token: string, id: string) {
    const own = await this.ownAgentSession(token, id);
    if (!own.archived)
      this.#o.sql.exec(
        `INSERT INTO agent_session_meta VALUES (?, ?, ?)
          ON CONFLICT (id) DO UPDATE SET archived = excluded.archived`,
        own.id,
        JSON.stringify(own.metadata),
        Date.now(),
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
    for (const us of sessions)
      await this.#o.workspace(us.workspace).eraseUserSecrets(us.capability);
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

  async listAgentSessions(token: string): Promise<{ sessions: AgentSessionView[] }> {
    const { workspace } = await this.claims(token);
    const rows = this.#o.sql
      .exec(`${INDEX} WHERE a.workspace = ? ORDER BY a.created, a.rowid`, workspace)
      .toArray() as unknown as (AgentRow & AgentMetaRow)[];
    return { sessions: rows.map(view) };
  }
}
