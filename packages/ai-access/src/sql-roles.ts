// The workspace's SQL role source (statewalker/statewalker-root#77): members, their roles and
// custom roles per project, and workspace-level roles, in the Workspace DO's SQLite. A project is
// known when it has a member or a custom role here.
import type { ProjectAccess, RoleEntries, RoleSource } from "./roles.js";

/** What the role source needs of SQLite: Durable Objects' `SqlStorage` has this shape. */
export interface SqlLike {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

export class SqlRoleSource implements RoleSource {
  readonly #sql: SqlLike;

  constructor(sql: SqlLike) {
    this.#sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS access_members (project TEXT NOT NULL, user TEXT NOT NULL,
      role TEXT NOT NULL, PRIMARY KEY (project, user, role))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS access_roles (project TEXT NOT NULL, name TEXT NOT NULL,
      entries TEXT NOT NULL, PRIMARY KEY (project, name))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS access_workspace (user TEXT NOT NULL, role TEXT NOT NULL,
      PRIMARY KEY (user, role))`);
  }

  #knows(project: string): boolean {
    return (
      this.#sql
        .exec(
          `SELECT 1 FROM access_members WHERE project = ?1
           UNION ALL SELECT 1 FROM access_roles WHERE project = ?1 LIMIT 1`,
          project,
        )
        .toArray().length > 0
    );
  }

  #definitions(project: string): Record<string, RoleEntries> {
    const defs: Record<string, RoleEntries> = {};
    for (const row of this.#sql
      .exec("SELECT name, entries FROM access_roles WHERE project = ?", project)
      .toArray()) {
      try {
        const entries = JSON.parse(String(row.entries)) as unknown;
        if (typeof entries === "string" || Array.isArray(entries))
          defs[String(row.name)] = entries as RoleEntries;
      } catch {
        // a row that is not JSON defines nothing
      }
    }
    return defs;
  }

  async access(project: string, user: string): Promise<ProjectAccess | undefined> {
    if (!this.#knows(project)) return undefined;
    const roles = this.#sql
      .exec(
        "SELECT role FROM access_members WHERE project = ? AND user = ? ORDER BY role",
        project,
        user,
      )
      .toArray()
      .map((r) => String(r.role));
    return { roles, definitions: roles.length ? this.#definitions(project) : {} };
  }

  async members(project: string): Promise<Record<string, string[]> | undefined> {
    if (!this.#knows(project)) return undefined;
    const members: Record<string, string[]> = {};
    for (const row of this.#sql
      .exec("SELECT user, role FROM access_members WHERE project = ? ORDER BY user, role", project)
      .toArray()) {
      const user = String(row.user);
      members[user] = [...(members[user] ?? []), String(row.role)];
    }
    return members;
  }

  async workspaceRoles(user: string): Promise<string[]> {
    return this.#sql
      .exec("SELECT role FROM access_workspace WHERE user = ? ORDER BY role", user)
      .toArray()
      .map((r) => String(r.role));
  }

  /** Sets the roles of members of a project; an empty list removes the member. */
  setMembers(project: string, members: Record<string, readonly string[]>): void {
    for (const [user, roles] of Object.entries(members)) {
      this.#sql.exec("DELETE FROM access_members WHERE project = ? AND user = ?", project, user);
      for (const role of new Set(roles))
        this.#sql.exec("INSERT INTO access_members VALUES (?, ?, ?)", project, user, role);
    }
  }

  /** Defines a project's custom roles; `null` removes one. */
  setRoles(project: string, roles: Record<string, RoleEntries | null>): void {
    for (const [name, entries] of Object.entries(roles)) {
      this.#sql.exec("DELETE FROM access_roles WHERE project = ? AND name = ?", project, name);
      if (entries !== null)
        this.#sql.exec(
          "INSERT INTO access_roles VALUES (?, ?, ?)",
          project,
          name,
          JSON.stringify(entries),
        );
    }
  }

  /** Sets a user's workspace-level roles; an empty list removes them. */
  setWorkspaceRoles(user: string, roles: readonly string[]): void {
    this.#sql.exec("DELETE FROM access_workspace WHERE user = ?", user);
    for (const role of new Set(roles))
      this.#sql.exec("INSERT INTO access_workspace VALUES (?, ?)", user, role);
  }
}
