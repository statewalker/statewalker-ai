// The Workspace DO's sessions (statewalker/statewalker-root#89): one user session per user and
// workspace, opened or resumed by an access token. It outlives the token.
import type { AccessClaims } from "@statewalker/ai-access";
import type { UserSessionView, WorkspacePort } from "./api.js";
import type { SqlLike } from "./sql.js";

export interface WorkspaceSessionsOptions {
  sql: SqlLike;
  workspace: string;
  /** The claims of a valid access token for this workspace; throws EAUTH otherwise. */
  verifyToken(token: string): Promise<AccessClaims>;
}

export class WorkspaceSessions implements WorkspacePort {
  readonly #o: WorkspaceSessionsOptions;

  constructor(options: WorkspaceSessionsOptions) {
    this.#o = options;
    options.sql.exec(`CREATE TABLE IF NOT EXISTS user_sessions (
      id TEXT PRIMARY KEY, user TEXT NOT NULL UNIQUE, created INTEGER NOT NULL)`);
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
}
