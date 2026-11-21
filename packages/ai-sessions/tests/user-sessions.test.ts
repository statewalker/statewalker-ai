// The User DO's storage across the tenancy change (statewalker/statewalker-root#127): agent
// sessions recorded before it hold no capability, so they cannot be revoked one by one; revoking
// one is refused rather than answered as done while the gate still accepts it.
import { DatabaseSync } from "node:sqlite";
import { WorkspaceAuthority } from "@statewalker/ai-access";
import { describe, expect, it } from "vitest";
import { type SqlLike, UserSessions, type WorkspaceGrants } from "../src/index.js";

const sqlite = (): SqlLike => {
  const db = new DatabaseSync(":memory:");
  return {
    exec: (query, ...bindings) => {
      const rows = db.prepare(query).all(...(bindings as never[]));
      return { toArray: () => rows as Record<string, unknown>[] };
    },
  };
};

const USER_CAP = WorkspaceAuthority.fromStored(WorkspaceAuthority.generate()).mintUser("ann");

function sessionsOver(sql: SqlLike) {
  const revoked: [string, string][] = [];
  const workspace = {
    userCapability: async () => USER_CAP,
    memberRoles: async () => ["reader"],
    setUserSession: async () => {},
    revoke: async (owner: string, target: string) => {
      revoked.push([owner, target]);
    },
  } as unknown as WorkspaceGrants;
  const sessions = new UserSessions({
    sql,
    user: "ann",
    // An empty profile: no user rules.
    profile: { exists: async () => false } as never,
    approvalTtlMs: 60_000,
    eraseProfile: async () => {},
    eraseStorage: async () => {},
    verifyToken: async () => ({ user: "ann", workspace: "default", issuer: "i", expires: 0 }),
    workspace: () => workspace,
  });
  return { sessions, revoked };
}

describe("user sessions", () => {
  it("refuses to revoke one by one an agent session recorded before it kept capabilities", async () => {
    const sql = sqlite();
    // The tables as a User DO made before statewalker/statewalker-root#127 holds them.
    sql.exec(`CREATE TABLE user_sessions (workspace TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE,
      mode TEXT NOT NULL, capability TEXT NOT NULL, created INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE agent_sessions (id TEXT PRIMARY KEY, workspace TEXT NOT NULL,
      project TEXT NOT NULL, agent TEXT NOT NULL, created INTEGER NOT NULL)`);
    sql.exec("INSERT INTO user_sessions VALUES ('default', 'us-1', 'default', ?, 1)", USER_CAP);
    sql.exec("INSERT INTO agent_sessions VALUES ('as-old', 'default', 'alpha', 'a', 1)");
    const { sessions, revoked } = sessionsOver(sql);
    await expect(sessions.revokeAgentSession("t", "as-old")).rejects.toThrow(/EINVAL/);
    expect(revoked).toEqual([]);
    const { sessions: listed } = await sessions.listAgentSessions("t");
    expect(listed).toEqual([expect.objectContaining({ id: "as-old", revoked: false })]);
    // Revoking the whole user session covers it.
    await sessions.revokeUserSession("t");
    expect(revoked).toEqual([[USER_CAP, USER_CAP]]);
  });

  it("revokes a new agent session's own capability at the workspace", async () => {
    const { sessions, revoked } = sessionsOver(sqlite());
    const { session, config } = await sessions.startAgentSession("t", {
      project: "alpha",
      agent: "a",
    });
    await sessions.revokeAgentSession("t", session.id);
    expect(revoked).toEqual([[USER_CAP, config.capability]]);
  });
});
