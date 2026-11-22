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
  approvalId,
  attenuateForAgentSession,
  codedError,
  DEFAULT_MODE,
  isMode,
  type ModeDefinition,
  PERMISSION_RULES_FILE,
  type PermissionRules,
  parseRules,
} from "@statewalker/ai-access";
import {
  approvalError,
  type FilesRpcMethod,
  type Limit,
  type LimitState,
  type ModelsConfig,
  rootedFiles,
} from "@statewalker/ai-environment";
import {
  KeyedLock,
  type MemoryCall,
  type MemoryCaps,
  type MemoryKind,
  MemoryService,
  type MemorySnapshot,
  memoryCall,
  memoryFiles,
  memoryRef,
  parseMemoryCaps,
  projectName,
  runMemoryCall,
  type Writer,
  writes,
  zipFiles,
} from "@statewalker/ai-memory";
import { type FilesApi, tryReadText } from "@statewalker/webrun-files";
import type {
  AgentRun,
  AgentSessionConfig,
  AgentSessionView,
  AgentsQuery,
  AgentView,
  ApiRequestKind,
  ApprovalAnswer,
  ApprovalView,
  CreatedServiceAccount,
  DatabaseCall,
  DatabaseView,
  DeleteSecretRequest,
  ForkOrigin,
  LimitsCall,
  LimitsView,
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
  UsageQuery,
  UsageRecordsPage,
  UsageRecordsQuery,
  UsageReport,
  UserPort,
  UserSessionView,
} from "./api.js";
import type { IndexedSession } from "./search.js";
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
  /**
   * Pins a fork's definitions (statewalker/statewalker-root#190): the source session's agent and
   * plugin bundles as they were pinned, its models (or `model`, if the user may use it); counts
   * the fork as an active session. The source must be the user's (ENOENT otherwise).
   */
  forkDefinitions(
    userCapability: string,
    req: { from: string; session: string; model?: string },
  ): Promise<PinnedDefinitions>;
  /**
   * The checkpoint of the gate's file pre-images of one of the user's sessions now
   * (statewalker/statewalker-root#191): null when it keeps none.
   */
  preImageCheckpoint?(userCapability: string, session: string): Promise<string | null>;
  /** A project's models as the user sees them; `discover` asks each provider's `/models`. */
  listModels(userCapability: string, query: ModelsQuery): Promise<ModelView[]>;
  /** The agents the user may start sessions on, in one project or every project they are in. */
  listAgents(userCapability: string, query: AgentsQuery): Promise<AgentView[]>;
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
  ): Promise<{
    capability: string;
    agent: string;
    run?: AgentRun;
    model?: string;
    plugins?: string[];
    limits?: Limit[];
    ownKeys?: boolean;
  }>;
  /**
   * One memory call on the workspace's project or agent memory (statewalker/statewalker-root#157),
   * decided with the capability: its user's roles, an agent session's mode.
   */
  memory(capability: string, call: MemoryCall): Promise<unknown>;
  /**
   * May a capability reach a profile kind (user memory, preferences) of a project, and change it?
   * The workspace verifies the capability, the membership, a sub-agent's limits and the mode
   * (EACCES, ENOENT, or an approval for user memory a rule asks about), and answers who writes
   * and the caps.
   */
  memoryAccess(capability: string, req: MemoryAccessRequest): Promise<MemoryAccess>;
  /** The memory scans, run where the secrets are: why each text may not be memory. */
  scanMemory(
    capability: string,
    req: { project?: string; texts: string[] },
  ): Promise<(string | undefined)[]>;
  /** Sets the user's `written_by` in the workspace's shared memory to the deleted user (erasure). */
  replaceMemoryAuthor(userCapability: string): Promise<void>;
  /** Holds and releases one of the user's streams against the limits on streams (#179). */
  holdStream(userCapability: string, id: string): Promise<void>;
  releaseStream(userCapability: string, id: string): Promise<void>;
  /**
   * Counts one session API request of the user against the workspace's rate limits
   * (statewalker/statewalker-root#180): waits on a `delay` limit for at most `maxDelayMs` (what the
   * request has left of its max delay), then ELIMIT (429).
   */
  admitRequest(userCapability: string, kind: ApiRequestKind, maxDelayMs?: number): Promise<void>;
  /** Agent sessions of this user that ended: they no longer count as active (#179). */
  sessionsEnded(userCapability: string, sessions: string[]): Promise<void>;
  /** The limits on the user's usage there now (a project's: EACCES for a non-member). */
  effectiveLimits(userCapability: string, query: { project?: string }): Promise<LimitState[]>;
  /** A usage report the user may see there (EACCES without its `usage.read`). */
  usage(userCapability: string, query: UsageQuery): Promise<UsageReport>;
  /** One call on the limits the user manages there (EACCES without `limits.write:<level>`). */
  manageLimits(userCapability: string, call: LimitsCall): Promise<LimitsView>;
  /** A page of the workspace's usage records; EACCES unless the user is its admin. */
  usageRecords(userCapability: string, query: UsageRecordsQuery): Promise<UsageRecordsPage>;
  /** The workspace's service accounts; EACCES unless the user is a workspace admin. */
  listServiceAccounts(userCapability: string): Promise<ServiceAccountView[]>;
  createServiceAccount(userCapability: string, name: string): Promise<CreatedServiceAccount>;
  deleteServiceAccount(userCapability: string, name: string): Promise<void>;
}

/** What a User DO asks the workspace before it reaches a profile kind (#157). */
export interface MemoryAccessRequest {
  kind: "user" | "preferences";
  /** The project (a user capability's; an agent session's is its own). */
  project?: string;
  write: boolean;
  /** The batch, which an approval is keyed by. */
  content?: string;
}

export interface MemoryAccess {
  user: string;
  project?: string;
  /** Whether the user is a member of the project now. */
  member: boolean;
  /** Whether the project exists in the workspace. */
  exists: boolean;
  caps: MemoryCaps;
  writer: Writer;
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
  /** The deployment's memory caps (JSON), for preferences, which belong to no project. */
  memoryCaps?: string;
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
  /** A fork's source, `{session, turn}` as JSON (statewalker/statewalker-root#190). */
  forked_from?: string | null;
  /** Its topic titles on the active path, as JSON (statewalker/statewalker-root#174). */
  topics?: string | null;
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
  ...(row.forked_from ? { forked_from: JSON.parse(row.forked_from) as ForkOrigin } : {}),
  ...(titlesOf(row).length ? { topics: titlesOf(row) } : {}),
});

/** A session's topic titles in the index. */
function titlesOf(row: { topics?: string | null }): string[] {
  try {
    const titles = row.topics ? (JSON.parse(row.topics) as unknown) : [];
    return Array.isArray(titles) ? titles.map(String) : [];
  } catch {
    return [];
  }
}

/** How many topic titles the index keeps per session, and how long each. */
const MAX_INDEXED_TOPICS = 100;
const MAX_INDEXED_TITLE = 200;

/** The session index with each session's metadata and archive time (a table of its own). */
const INDEX = `SELECT a.*, m.metadata, m.archived FROM agent_sessions a
  LEFT JOIN agent_session_meta m ON m.id = a.id`;

export class UserSessions implements UserPort {
  readonly #o: UserSessionsOptions;
  /** Writes to each kind of the profile are serialized (#157). */
  readonly #memoryLock = new KeyedLock();

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
      // statewalker/statewalker-root#190: a fork's source.
      ["forked_from", "TEXT"],
      // statewalker/statewalker-root#174: the topic titles on the session's active path.
      ["topics", "TEXT"],
    ] as const)
      if (!columns.has(name))
        this.#o.sql.exec(`ALTER TABLE agent_sessions ADD COLUMN ${name} ${type}`);
    // One row per approval (keyed by the action, so per session): a retried identical action
    // reopens the same row once it was answered or expired.
    this.#o.sql.exec(`CREATE TABLE IF NOT EXISTS approvals (
      id TEXT NOT NULL, workspace TEXT NOT NULL, session TEXT NOT NULL, project TEXT NOT NULL,
      request TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL,
      expires INTEGER NOT NULL, PRIMARY KEY (workspace, id))`);
    // statewalker/statewalker-root#157: an approval of a preference change is used once.
    // Keyed by the approval and when it was asked: the same batch asked again is a new approval.
    this.#o.sql.exec(`CREATE TABLE IF NOT EXISTS memory_approvals_used (
      id TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (id, created))`);
    // statewalker/statewalker-root#125: metadata and archiving, beside the index.
    this.#o.sql.exec(`CREATE TABLE IF NOT EXISTS agent_session_meta (
      id TEXT PRIMARY KEY, metadata TEXT NOT NULL, archived INTEGER)`);
  }

  #now(): number {
    return this.#o.now?.() ?? Date.now();
  }

  #approvalView(row: ApprovalRow): ApprovalView {
    const expired =
      (row.status === "pending" || row.status === "blocked") && Number(row.expires) <= this.#now();
    // A sub-agent's approval names its tree's root (statewalker/statewalker-ai#88).
    const root = this.#one<{ root: string | null }>(
      "SELECT root FROM agent_sessions WHERE id = ?",
      row.session,
    )?.root;
    return {
      ...(JSON.parse(row.request) as ApprovalRequest),
      workspace: row.workspace,
      ...(root && root !== row.session ? { root } : {}),
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
      blocked: this.#approvals(row.workspace).filter((a) => a.status === "blocked"),
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

  /**
   * Records an action auto mode's risk classifier blocked in one of this user's agent sessions
   * (statewalker/statewalker-root#137), listed on /v1/me until it expires; approving it retries
   * exactly that action. Told by the agent session's DO, for a session in this user's index only.
   * An approval pending for the same action stays as it is.
   */
  async recordBlocked(session: string, request: ApprovalRequest): Promise<ApprovalView> {
    const row = this.#one<AgentRow>("SELECT * FROM agent_sessions WHERE id = ?", String(session));
    if (!row) throw codedError("ENOENT", "no such agent session");
    const own = view(row);
    if (request.session !== own.id || request.project !== own.project)
      throw codedError("EINVAL", "a block of another session");
    const now = this.#now();
    const found = this.#one<ApprovalRow>(
      "SELECT * FROM approvals WHERE workspace = ? AND id = ?",
      own.workspace,
      request.id,
    );
    if (found?.status !== "pending" || Number(found.expires) <= now)
      this.#o.sql.exec(
        "INSERT OR REPLACE INTO approvals VALUES (?, ?, ?, ?, ?, 'blocked', ?, ?)",
        request.id,
        own.workspace,
        own.id,
        own.project,
        JSON.stringify(request),
        now,
        now + this.#o.approvalTtlMs,
      );
    return this.#approvalView(
      this.#one<ApprovalRow>(
        "SELECT * FROM approvals WHERE workspace = ? AND id = ?",
        own.workspace,
        request.id,
      ) as ApprovalRow,
    );
  }

  /**
   * Cancels the pending approvals of turns one of this user's agent sessions rewound
   * (statewalker/statewalker-root#190): answering them is refused. Told by that session's DO.
   */
  async cancelApprovals(session: string, ids: string[]): Promise<void> {
    if (!this.#one("SELECT 1 FROM agent_sessions WHERE id = ?", String(session)))
      throw codedError("ENOENT", "no such agent session");
    for (const id of ids)
      this.#o.sql.exec(
        "UPDATE approvals SET status = 'cancelled' WHERE session = ? AND id = ? AND status IN ('pending', 'blocked')",
        String(session),
        String(id),
      );
  }

  async listApprovals(token: string): Promise<{ approvals: ApprovalView[] }> {
    const { workspace } = await this.claims(token);
    return { approvals: this.#approvals(workspace) };
  }

  /**
   * Answers one of the caller's pending approvals. An allow is granted at the gate (with the
   * user capability), which re-checks it against the mode and roles when the action runs.
   */
  /** Holds one stream of the user in the token's workspace (ELIMIT over a limit on streams). */
  async holdStream(token: string): Promise<string> {
    const us = await this.#userSession(token);
    const id = `st-${crypto.randomUUID()}`;
    await this.#o.workspace(us.workspace).holdStream(us.capability, id);
    return id;
  }

  /** Counts one session API request of the user in the token's workspace (#180). */
  async admitRequest(token: string, kind: ApiRequestKind, maxDelayMs?: number): Promise<void> {
    const us = await this.#userSession(token);
    await this.#o.workspace(us.workspace).admitRequest(us.capability, kind, maxDelayMs);
  }

  async releaseStream(token: string, id: string): Promise<void> {
    const us = await this.#userSession(token);
    await this.#o.workspace(us.workspace).releaseStream(us.capability, String(id));
  }

  /** Whether the user allowed this approval of this agent session (statewalker/statewalker-root#179). */
  approvalAllowed(session: string, id: string): boolean {
    const row = this.#one<{ status: string }>(
      "SELECT status FROM approvals WHERE session = ? AND id = ?",
      session,
      id,
    );
    return row?.status === "allowed";
  }

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
    if (current.status === "cancelled")
      throw codedError("EINVAL", "the approval was cancelled: its turn was rewound");
    // A block of auto mode's classifier is answered like a pending approval: allow retries it.
    if (current.status !== "pending" && current.status !== "blocked")
      throw codedError("EINVAL", "the approval was answered");
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
      "UPDATE approvals SET status = ? WHERE workspace = ? AND id = ? AND status IN ('pending', 'blocked')",
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
        ...(pinned.plugins ? { plugins: pinned.plugins } : {}),
        ...limitsOf(pinned.limits),
        // The start request's limits are the user's own: theirs to replace later (#181).
        ...(req.limits?.length ? { ownLimits: req.limits } : {}),
        ...(pinned.ownKeys ? { ownKeys: true } : {}),
        ...(req.unattended ? { unattended: true } : {}),
      },
    };
  }

  /**
   * Starts a fork of one of the caller's top-level agent sessions (statewalker/statewalker-root#190):
   * the same project and agent, the definitions the source pinned (its model, or another the user
   * may use), a capability attenuated now from the user session's (so from the user's current roles
   * and mode, with no session-scope approval of the source), and the source's limits, counted
   * afresh in the fork's own DO.
   */
  async forkAgentSession(
    token: string,
    from: string,
    req: { at_turn: string; model?: string; limits?: Limit[] },
  ): Promise<{ session: AgentSessionView; config: AgentSessionConfig }> {
    const us = await this.#userSession(token);
    const source = await this.ownAgentSession(token, from);
    if (source.parent) throw codedError("EINVAL", "only a top-level session can be forked");
    const id = `as-${crypto.randomUUID()}`;
    const pinned = await this.#o.workspace(us.workspace).forkDefinitions(us.capability, {
      from: source.id,
      session: id,
      ...(req.model ? { model: req.model } : {}),
    });
    const capability = attenuateForAgentSession(us.capability, {
      session: id,
      project: source.project,
      agent: pinned.agent,
      unattended: source.unattended,
    });
    // The files' checkpoint then: the source's pre-images serve as its turns' checkpoints (#191).
    const checkpoint = await this.#o
      .workspace(us.workspace)
      .preImageCheckpoint?.(us.capability, source.id);
    const forkedFrom: ForkOrigin = {
      session: source.id,
      turn: String(req.at_turn),
      ...(checkpoint ? { checkpoint } : {}),
    };
    const row: AgentRow = {
      id,
      workspace: us.workspace,
      project: source.project,
      agent: pinned.agent,
      created: Date.now(),
      capability,
      unattended: source.unattended ? 1 : 0,
      revoked: 0,
      parent: null,
      root: null,
      forked_from: JSON.stringify(forkedFrom),
    };
    try {
      await this.#pushUserSession(us);
    } catch (e) {
      // The fork was counted as an active session: it no longer is.
      await this.#o
        .workspace(us.workspace)
        .sessionsEnded(us.capability, [id])
        .catch(() => {});
      throw e;
    }
    this.#o.sql.exec(
      `INSERT INTO agent_sessions (id, workspace, project, agent, created, capability, unattended,
        revoked, forked_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.workspace,
      row.project,
      row.agent,
      row.created,
      row.capability,
      row.unattended,
      row.revoked,
      row.forked_from,
    );
    this.#o.sql.exec("INSERT INTO agent_session_meta VALUES (?, '{}', NULL)", row.id);
    // The source's limits (its start request's and the defaults it pinned), and today's defaults.
    const same = (a: Limit, b: Limit) => JSON.stringify(a) === JSON.stringify(b);
    const own = (req.limits ?? []).filter((l) => !(pinned.limits ?? []).some((p) => same(p, l)));
    return {
      session: view({ ...row, metadata: "{}", archived: null }),
      config: {
        id: row.id,
        user: this.#o.user,
        workspace: row.workspace,
        project: row.project,
        agent: row.agent,
        capability,
        ...(pinned.run ? { run: pinned.run } : {}),
        ...(pinned.model ? { model: pinned.model } : {}),
        ...(pinned.plugins ? { plugins: pinned.plugins } : {}),
        forked_from: forkedFrom,
        ...limitsOf(pinned.limits, own),
        ...(pinned.ownKeys ? { ownKeys: true } : {}),
        ...(row.unattended ? { unattended: true } : {}),
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
    const { capability, agent, run, model, plugins, limits, ownKeys } = await this.#o
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
        ...(plugins ? { plugins } : {}),
        parent: String(row.parent),
        root: String(row.root),
        ...(run ? { run } : {}),
        ...(model ? { model } : {}),
        ...(req.tools ? { tools: [...req.tools] } : {}),
        ...(req.mode ? { mode: req.mode } : {}),
        ...limitsOf(limits),
        ...(ownKeys ? { ownKeys: true } : {}),
        ...(row.unattended ? { unattended: true } : {}),
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
    const tree = this.#tree(row.id);
    // They no longer count as active sessions (statewalker/statewalker-root#179).
    await this.#o.workspace(us.workspace).sessionsEnded(us.capability, tree);
    if (!row.revoked) await this.#o.workspace(us.workspace).revoke(us.capability, row.capability);
    for (const id of tree)
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
    const us = await this.#userSession(token);
    const own = await this.ownAgentSession(token, id);
    await this.#o.workspace(us.workspace).sessionsEnded(us.capability, [own.id]);
    this.#o.sql.exec("DELETE FROM agent_session_meta WHERE id = ?", own.id);
    this.#o.sql.exec("DELETE FROM agent_sessions WHERE id = ?", own.id);
  }

  /**
   * The caller's profile: their preferences, and the projects it holds user memory of, deleted and
   * left ones included, each with its state where the user has a user session in its workspace.
   */
  async profile(token: string): Promise<ProfileView> {
    const us = await this.#userSession(token);
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
    const sessions = new Map(
      (
        this.#o.sql.exec("SELECT * FROM user_sessions").toArray() as unknown as UserSessionRow[]
      ).map((r) => [r.workspace, r]),
    );
    for (const p of projects) {
      const at = sessions.get(p.workspace);
      if (!at) continue;
      try {
        const access = await this.#o
          .workspace(p.workspace)
          .memoryAccess(at.capability, { kind: "user", project: p.project, write: false });
        p.state = access.member ? "member" : access.exists ? "left" : "gone";
      } catch {
        // The workspace cannot say now; the project is listed without a state.
      }
    }
    const preferences = await this.#profileMemory(us.workspace, undefined, us.capability).list(
      "preferences",
    );
    return {
      user: this.#o.user,
      preferences: preferences.entries,
      projects,
    };
  }

  /**
   * The memory service on the profile's kinds (statewalker/statewalker-root#157): preferences, and
   * the user memory of one project. Secrets are matched by the workspace, where they are.
   */
  #profileMemory(
    workspace: string,
    project: string | undefined,
    capability: string,
    caps: MemoryCaps = parseMemoryCaps(this.#o.memoryCaps),
  ): MemoryService {
    const profile = this.#o.profile;
    const stores: Partial<Record<MemoryKind, FilesApi>> = {
      preferences: rootedFiles(profile, "/preferences"),
    };
    if (project !== undefined)
      stores.user = rootedFiles(profile, `/projects/${workspace}/${projectName(project)}`);
    return new MemoryService({
      files: memoryFiles(stores),
      kinds: Object.keys(stores) as MemoryKind[],
      caps,
      scan: (texts) => this.#o.workspace(workspace).scanMemory(capability, { project, texts }),
      lock: this.#memoryLock,
      lockKey: (kind) => (kind === "preferences" ? "preferences" : `user/${workspace}/${project}`),
    });
  }

  /**
   * One memory call of the caller (the memory API, statewalker/statewalker-root#157): project and
   * agent memory are the workspace's; preferences and user memory are in the profile. The user
   * memory of a project they left stays theirs to read, export and erase; no new writes.
   */
  async memory(token: string, raw: MemoryCall): Promise<unknown> {
    const call = memoryCall(raw);
    const us = await this.#userSession(token);
    const ws = this.#o.workspace(us.workspace);
    if (call.op === "agents") return ws.memory(us.capability, call);
    if ((call.op as string) === "prime")
      throw codedError("EINVAL", "only agent sessions are primed");
    const ref = memoryRef(call.kind);
    if (ref.kind === "project" || ref.kind === "agent") return ws.memory(us.capability, call);
    const writer: Writer = { user: this.#o.user };
    if (ref.kind === "preferences")
      return runMemoryCall(
        this.#profileMemory(us.workspace, undefined, us.capability),
        "preferences",
        call,
        writer,
      );
    const project = projectName(call.project);
    const access = await ws.memoryAccess(us.capability, { kind: "user", project, write: false });
    if (!access.member) {
      const held = await this.#o.profile.exists(`/projects/${us.workspace}/${project}`);
      if (!held || (call.op === "batch" && writes(call)))
        throw codedError("ENOENT", "no such memory");
    }
    return runMemoryCall(
      this.#profileMemory(us.workspace, project, us.capability, access.caps),
      "user",
      call,
      writer,
    );
  }

  /**
   * One memory call of one of this user's agent sessions (the memory tool) on its user memory or
   * the user's preferences, told by the session's DO, which proves it is the session by the
   * capability it holds. The workspace decides the capability, the membership and the mode; a
   * sub-agent writes neither; a change of preferences waits on the user's approval in every mode.
   */
  /** The agent session a capability proves (EACCES for any other). */
  #provenSession(session: string, capability: string): AgentRow & AgentMetaRow {
    const row = this.#one<AgentRow & AgentMetaRow>(`${INDEX} WHERE a.id = ?`, String(session));
    if (!row?.capability || row.capability !== capability)
      throw codedError("EACCES", "not an agent session of this user");
    return row;
  }

  async sessionTopics(session: string, capability: string, titles: string[]): Promise<void> {
    const row = this.#provenSession(session, capability);
    const list = (Array.isArray(titles) ? titles : [])
      .slice(0, MAX_INDEXED_TOPICS)
      .map((t) => String(t).slice(0, MAX_INDEXED_TITLE));
    this.#o.sql.exec(
      "UPDATE agent_sessions SET topics = ? WHERE id = ?",
      list.length ? JSON.stringify(list) : null,
      row.id,
    );
  }

  /**
   * The sessions an agent session's search reaches: the user's own agent sessions in the same
   * workspace and project, sub-agents', archived and revoked ones included, never the caller. A
   * revoked or archived caller searches nothing (EACCES).
   */
  async searchScope(session: string, capability: string): Promise<{ sessions: IndexedSession[] }> {
    const row = this.#provenSession(session, capability);
    if (row.revoked || row.archived) throw codedError("EACCES", "the agent session is revoked");
    const rows = this.#o.sql
      .exec(
        "SELECT * FROM agent_sessions WHERE workspace = ? AND project = ? AND id != ? ORDER BY created DESC",
        row.workspace,
        row.project,
        row.id,
      )
      .toArray() as unknown as AgentRow[];
    return {
      sessions: rows.map((r) => ({
        id: r.id,
        agent: r.agent,
        created: Number(r.created),
        ...(r.parent ? { parent: r.parent } : {}),
        topics: titlesOf(r),
      })),
    };
  }

  async sessionMemory(session: string, capability: string, raw: MemoryCall): Promise<unknown> {
    const call = memoryCall(raw);
    const row = this.#one<AgentRow & AgentMetaRow>(`${INDEX} WHERE a.id = ?`, String(session));
    if (!row?.capability || row.capability !== capability)
      throw codedError("EACCES", "not an agent session of this user");
    if (row.revoked || row.archived) throw codedError("EACCES", "the agent session is revoked");
    const ws = this.#o.workspace(row.workspace);
    if ((call.op as string) === "prime") {
      const access = await ws.memoryAccess(capability, { kind: "user", write: false });
      return this.#profileMemory(row.workspace, row.project, capability, access.caps).prime([
        "preferences",
        "user",
      ]) as Promise<MemorySnapshot>;
    }
    const ref = memoryRef(call.kind);
    if (ref.kind !== "user" && ref.kind !== "preferences")
      throw codedError("ENOENT", "no such memory");
    if (call.op === "erase") throw codedError("EACCES", "only a person erases memory");
    const write = writes(call);
    if (write && row.parent)
      throw codedError(
        "EACCES",
        "a sub-agent writes only its own agent memory and the project memory",
      );
    const content = JSON.stringify(call.actions ?? []);
    const access = await ws.memoryAccess(capability, { kind: ref.kind, write, content });
    let claimed: (() => void) | undefined;
    if (write && ref.kind === "preferences") {
      const id = await approvalId(
        row.id,
        "memory",
        "preferences",
        new TextEncoder().encode(content),
      );
      claimed = this.#claimMemoryApproval(row.id, id);
      if (!claimed) {
        if (row.unattended)
          throw codedError(
            "EACCES",
            "the user approves every change to their preferences, and this session is unattended",
          );
        throw approvalError({
          id,
          session: row.id,
          project: row.project,
          action: { method: "memory", path: "preferences", size: content.length },
          permission: "memory.write:preferences",
          reason: "the user approves every change an agent makes to their preferences",
        });
      }
    }
    try {
      return await runMemoryCall(
        this.#profileMemory(row.workspace, row.project, capability, access.caps),
        ref.kind,
        call,
        access.writer,
      );
    } catch (e) {
      // A refused batch does not use its approval: the same batch may run once it fits.
      claimed?.();
      throw e;
    }
  }

  /**
   * Claims the user's allowed approval of a preference change for one run: undefined when it is
   * not allowed or was used already; otherwise a function that gives it back (the batch failed).
   */
  #claimMemoryApproval(session: string, id: string): (() => void) | undefined {
    const approval = this.#one<{ created: number }>(
      "SELECT created FROM approvals WHERE session = ? AND id = ? AND status = 'allowed'",
      session,
      id,
    );
    if (!approval) return undefined;
    const created = Number(approval.created);
    if (this.#one("SELECT id FROM memory_approvals_used WHERE id = ? AND created = ?", id, created))
      return undefined;
    this.#o.sql.exec("INSERT INTO memory_approvals_used VALUES (?, ?)", id, created);
    return () =>
      this.#o.sql.exec(
        "DELETE FROM memory_approvals_used WHERE id = ? AND created = ?",
        id,
        created,
      );
  }

  /** The caller's whole profile, a ZIP of its Markdown files (#157). */
  async exportProfile(token: string): Promise<Uint8Array> {
    await this.claims(token);
    const files: { path: string; bytes: Uint8Array }[] = [];
    const profile = this.#o.profile;
    if (await profile.exists("/"))
      for await (const e of profile.list("/", { recursive: true })) {
        if (e.kind !== "file") continue;
        const chunks: Uint8Array[] = [];
        for await (const chunk of profile.read(e.path)) chunks.push(chunk);
        const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
        let at = 0;
        for (const c of chunks) {
          bytes.set(c, at);
          at += c.length;
        }
        files.push({ path: e.path, bytes });
      }
    files.sort((a, b) => a.path.localeCompare(b.path));
    return zipFiles(files);
  }

  /** Erases the caller's profile (preferences and all user memory); the user stays (#157). */
  async eraseProfile(token: string): Promise<{ erased: true }> {
    await this.claims(token);
    await this.#o.eraseProfile();
    return { erased: true };
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
      // Their entries in shared memory stay, written by the fixed "deleted user" (#157).
      await this.#o.workspace(us.workspace).replaceMemoryAuthor(us.capability);
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
    if (us) {
      const ids = this.#o.sql
        .exec("SELECT id FROM agent_sessions WHERE workspace = ? AND revoked = 0", workspace)
        .toArray()
        .map((r) => String(r.id));
      await this.#o.workspace(workspace).sessionsEnded(us.capability, ids);
      await this.#o.workspace(workspace).revoke(us.capability, us.capability);
    }
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

  async listAgents(token: string, query: AgentsQuery): Promise<{ agents: AgentView[] }> {
    const us = await this.#userSession(token);
    return { agents: await this.#o.workspace(us.workspace).listAgents(us.capability, query) };
  }

  async getModelConfig(token: string): Promise<ModelsConfig> {
    const us = await this.#userSession(token);
    return this.#o.workspace(us.workspace).getModelConfig(us.capability);
  }

  async setModelConfig(token: string, config: unknown): Promise<ModelsConfig> {
    const us = await this.#userSession(token);
    return this.#o.workspace(us.workspace).setModelConfig(us.capability, config);
  }

  async effectiveLimits(
    token: string,
    query: { project?: string },
  ): Promise<{ limits: LimitState[] }> {
    const us = await this.#userSession(token);
    return {
      limits: await this.#o.workspace(us.workspace).effectiveLimits(us.capability, query),
    };
  }

  async usage(token: string, query: UsageQuery): Promise<UsageReport> {
    const us = await this.#userSession(token);
    return this.#o.workspace(us.workspace).usage(us.capability, query);
  }

  async manageLimits(token: string, call: LimitsCall): Promise<LimitsView> {
    const us = await this.#userSession(token);
    return this.#o.workspace(us.workspace).manageLimits(us.capability, call);
  }

  async usageRecords(token: string, query: UsageRecordsQuery): Promise<UsageRecordsPage> {
    const us = await this.#userSession(token);
    return this.#o.workspace(us.workspace).usageRecords(us.capability, query);
  }

  /** The agent each of these sessions of the user runs; unknown ones left out. */
  sessionAgents(ids: readonly string[]): Map<string, string> {
    const found = new Map<string, string>();
    for (const id of new Set(ids)) {
      const row = this.#one<{ agent: string }>("SELECT agent FROM agent_sessions WHERE id = ?", id);
      if (row) found.set(id, String(row.agent));
    }
    return found;
  }

  async listAgentSessions(token: string): Promise<{ sessions: AgentSessionView[] }> {
    const { workspace } = await this.claims(token);
    const rows = this.#o.sql
      .exec(`${INDEX} WHERE a.workspace = ? ORDER BY a.created, a.rowid`, workspace)
      .toArray() as unknown as (AgentRow & AgentMetaRow)[];
    return { sessions: rows.map(view) };
  }
}

/** A session's limits: the broader levels' session defaults and the start request's own. */
function limitsOf(...lists: (Limit[] | undefined)[]): { limits?: Limit[] } {
  const all = lists.flatMap((l) => l ?? []);
  return all.length ? { limits: all } : {};
}
