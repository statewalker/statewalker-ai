// The Workspace DO's sessions (statewalker/statewalker-root#89): one user session per user and
// workspace, opened or resumed by an access token, outliving it; and the agent sessions started
// from it, each in one project where the user is a member, each with its own capability.
import { type AccessClaims, codedError } from "@statewalker/ai-access";
import type {
  AgentSessionConfig,
  AgentSessionView,
  StartSessionRequest,
  UserSessionView,
  WorkspacePort,
} from "./api.js";
import type { SqlLike } from "./sql.js";

export interface WorkspaceSessionsOptions {
  sql: SqlLike;
  workspace: string;
  /** The claims of a valid access token for this workspace; throws EAUTH otherwise. */
  verifyToken(token: string): Promise<AccessClaims>;
  /** The user's role in the project now (the role source), or undefined for a non-member. */
  roleOf(project: string, user: string): Promise<string | undefined>;
  /** The capability of a new agent session, signed by the workspace's root key. */
  mintCapability(agentSession: string): string;
}

interface AgentRow {
  id: string;
  user_session: string;
  project: string;
  agent: string;
  created: number;
}

const view = (row: AgentRow): AgentSessionView => ({
  id: row.id,
  project: row.project,
  agent: row.agent,
  created: Number(row.created),
});

export class WorkspaceSessions implements WorkspacePort {
  readonly #o: WorkspaceSessionsOptions;

  constructor(options: WorkspaceSessionsOptions) {
    this.#o = options;
    options.sql.exec(`CREATE TABLE IF NOT EXISTS user_sessions (
      id TEXT PRIMARY KEY, user TEXT NOT NULL UNIQUE, created INTEGER NOT NULL)`);
    options.sql.exec(`CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY, user_session TEXT NOT NULL, project TEXT NOT NULL, agent TEXT NOT NULL,
      created INTEGER NOT NULL)`);
  }

  #one<T>(query: string, ...args: unknown[]): T | undefined {
    return this.#o.sql.exec(query, ...args).toArray()[0] as T | undefined;
  }

  async openUserSession(token: string): Promise<UserSessionView> {
    const { user } = await this.#o.verifyToken(token);
    let row = this.#one<{ id: string; created: number }>(
      "SELECT id, created FROM user_sessions WHERE user = ?",
      user,
    );
    if (!row) {
      row = { id: `us-${crypto.randomUUID()}`, created: Date.now() };
      this.#o.sql.exec("INSERT INTO user_sessions VALUES (?, ?, ?)", row.id, user, row.created);
    }
    return { id: row.id, user, workspace: this.#o.workspace, created: Number(row.created) };
  }

  async ownAgentSession(token: string, id: string): Promise<AgentSessionView> {
    const us = await this.openUserSession(token);
    const row = this.#one<AgentRow>(
      "SELECT * FROM agent_sessions WHERE id = ? AND user_session = ?",
      id,
      us.id,
    );
    if (!row) throw codedError("ENOENT", "no such agent session");
    return view(row);
  }

  /** The project and user of an agent session, for the gate (no token: the capability). */
  sessionFacts(id: string): { project: string; user: string } | undefined {
    return this.#one<{ project: string; user: string }>(
      `SELECT a.project AS project, u.user AS user FROM agent_sessions a
       JOIN user_sessions u ON u.id = a.user_session WHERE a.id = ?`,
      id,
    );
  }

  async startAgentSession(
    token: string,
    req: StartSessionRequest,
  ): Promise<{ session: AgentSessionView; config: AgentSessionConfig }> {
    const us = await this.openUserSession(token);
    const role = await this.#o.roleOf(req.project, us.user);
    if (!role) throw codedError("EACCES", `${us.user} is not a member of ${req.project}`);
    const row: AgentRow = {
      id: `as-${crypto.randomUUID()}`,
      user_session: us.id,
      project: req.project,
      agent: req.agent,
      created: Date.now(),
    };
    this.#o.sql.exec(
      "INSERT INTO agent_sessions VALUES (?, ?, ?, ?, ?)",
      row.id,
      row.user_session,
      row.project,
      row.agent,
      row.created,
    );
    return {
      session: view(row),
      config: {
        id: row.id,
        workspace: this.#o.workspace,
        project: row.project,
        agent: row.agent,
        capability: this.#o.mintCapability(row.id),
      },
    };
  }
}
