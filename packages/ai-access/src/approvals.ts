// What the gate knows of each user session's decisions (statewalker/statewalker-root#79, #89,
// built by #124), in the Workspace DO's SQLite. A User DO pushes them here with its user
// capability (user → workspace, never the other way): the user session's mode and the user's own
// rules, the session rules "approve for this session" adds, and the approvals the user granted.
// The gate reads them at every action, so a mode switch reaches a running agent session at its
// next call. An approval is keyed by the action itself (agent session, method, path, content), so
// a retried identical action waits on, or is answered by, the same approval.
import type { PermissionRules } from "./modes.js";
import type { SqlLike } from "./sql-roles.js";

/** The approval answering one exact action of one agent session. */
export async function approvalId(
  session: string,
  method: string,
  path: string,
  content?: Uint8Array,
): Promise<string> {
  const head = new TextEncoder().encode(`${JSON.stringify([session, method, path])}\n`);
  const bytes = new Uint8Array(head.length + (content?.length ?? 0));
  bytes.set(head);
  if (content) bytes.set(content, head.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `ap-${[...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** A file call the gate stopped because the mode or a rule asks: it waits on this approval. */
export interface ApprovalRequest {
  /** Keyed by the exact action: a retried identical call gets the same id. */
  id: string;
  session: string;
  project: string;
  action: { method: string; path: string; size?: number };
  /** The permission asked for, with its target relative to the project. */
  permission: string;
  reason: string;
}

/** An approval a user granted, as their User DO pushes it to the gate. */
export interface ApprovalGrant {
  id: string;
  session: string;
  scope: "once" | "session";
  /** The permission asked for (target relative to the project): a session rule for scope "session". */
  permission: string;
  /** When the grant lapses (epoch ms). */
  expires: number;
}

export interface UserSessionState {
  mode: string;
  rules: PermissionRules;
}

export class ApprovalRegistry {
  readonly #sql: SqlLike;

  constructor(sql: SqlLike) {
    this.#sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS gate_user_sessions (user TEXT PRIMARY KEY,
      mode TEXT NOT NULL, rules TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS gate_session_rules (session TEXT NOT NULL,
      user TEXT NOT NULL, permission TEXT NOT NULL, PRIMARY KEY (session, user, permission))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS gate_grants (id TEXT NOT NULL, session TEXT NOT NULL,
      user TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY (id, session, user))`);
  }

  setUserSession(user: string, state: UserSessionState): void {
    this.#sql.exec(
      "INSERT OR REPLACE INTO gate_user_sessions VALUES (?, ?, ?)",
      user,
      state.mode,
      JSON.stringify(state.rules ?? {}),
    );
  }

  /** The user session's mode and rules; undefined until its User DO pushed them. */
  userSession(user: string): UserSessionState | undefined {
    const row = this.#sql
      .exec("SELECT mode, rules FROM gate_user_sessions WHERE user = ?", user)
      .toArray()[0];
    return row ? { mode: String(row.mode), rules: JSON.parse(String(row.rules)) } : undefined;
  }

  grant(user: string, grant: ApprovalGrant): void {
    this.#sql.exec(
      "INSERT OR REPLACE INTO gate_grants VALUES (?, ?, ?, ?)",
      grant.id,
      grant.session,
      user,
      grant.expires,
    );
    if (grant.scope === "session")
      this.#sql.exec(
        "INSERT OR IGNORE INTO gate_session_rules VALUES (?, ?, ?)",
        grant.session,
        user,
        grant.permission,
      );
  }

  /** The allow rules "approve for this session" added to one agent session of one user. */
  sessionRules(session: string, user: string): PermissionRules {
    const rows = this.#sql
      .exec(
        "SELECT permission FROM gate_session_rules WHERE session = ? AND user = ? ORDER BY rowid",
        session,
        user,
      )
      .toArray();
    return { allow: rows.map((r) => String(r.permission)) };
  }

  /** Uses up the user's unexpired grant of this approval to this session; whether there was one. */
  consume(id: string, session: string, user: string, now = Date.now()): boolean {
    this.#sql.exec("DELETE FROM gate_grants WHERE expires <= ?", now);
    const found = this.#sql
      .exec(
        "SELECT 1 FROM gate_grants WHERE id = ? AND session = ? AND user = ?",
        id,
        session,
        user,
      )
      .toArray().length;
    if (found)
      this.#sql.exec(
        "DELETE FROM gate_grants WHERE id = ? AND session = ? AND user = ?",
        id,
        session,
        user,
      );
    return found > 0;
  }
}
