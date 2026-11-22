// The database gate (statewalker/statewalker-root#81, built by #136), in the Workspace DO as for
// files: every database call of every holder (an agent session, a plugin tool of one, or the
// user's own session) is decided here, then forwarded to that database's own DO, a private backend
// nothing else reaches.
// - The capability says who calls and, for an agent session, the one project it acts in; the
//   project's `.system/databases` says which databases exist; the member's roles now say what the
//   holder may do (`db.read`, `db.write`, `db.admin`), every block of the capability agreeing.
// - A statement taken for a read runs on the database's read-only server; so does any call of a
//   holder with only `db.read`, whose writes run inside the call and are rolled back. A write with
//   `db.write` runs on the read-write server; for an agent the mode decides it first (`default` and
//   `plan` ask, `acceptEdits` allows), and an "ask" waits on an approval of that exact action.
// - Tool-private databases (`<plugin>:<name>`) are reached only with a capability the workspace
//   narrowed for one of that plugin's tools; to anyone else they are absent.
// - Stream and request ids are the holder's own: each is mixed with the holder's capability
//   before it reaches the backend, so no holder reads another's result or retried answer.
import {
  type AgentSessionFacts,
  approvalId,
  codedError,
  type DatabaseAction as DbPermission,
  type ModeDecision,
  type RoleGrant,
  type ToolGrant,
  type WorkspaceAuthority,
} from "@statewalker/ai-access";
import {
  approvalError,
  DATABASES_FILE,
  type DatabaseAction,
  DB_RPC_METHODS,
  type DbRpcMethod,
  encodeDatabaseAction,
  formatDatabases,
  isDatabaseName,
  isReadStatement,
  parseDatabases,
  privateDatabaseOf,
  type SqlLike,
} from "@statewalker/ai-environment";
import { type FilesApi, tryReadText, writeText } from "@statewalker/webrun-files";
import type { Database, DbServerKind } from "./database-do.js";

/** A database as a holder sees it listed. */
export interface DatabaseView {
  name: string;
  access: "read" | "write";
  bytes: number;
}

/** One db-rpc call on a database, as a holder sends it to the gate. */
export interface DatabaseCall {
  /** The project; an agent session's capability names its own, so it may be left out. */
  project?: string;
  database: string;
  method: DbRpcMethod;
  args: unknown[];
}

export interface DatabaseGateOptions {
  sql: SqlLike;
  workspace: string;
  authority: WorkspaceAuthority;
  store: Promise<FilesApi>;
  systemFolder: string;
  /** The database DO of `<workspace>/<project>/<database>`. */
  backend(name: string): DurableObjectStub<Database>;
  /** The member's roles in a project now. */
  access(project: string, user: string): Promise<{ member: boolean; grants: RoleGrant[] }>;
  /** The mode's verdict on one action of an agent session now (unattended asks settled). */
  decide(
    facts: AgentSessionFacts,
    req: { area: "db"; action: DbPermission; target: string },
  ): Promise<ModeDecision>;
  /** Uses up the user's grant of an approval to the session; whether there was one. */
  consume(facts: AgentSessionFacts, id: string): Promise<boolean>;
  /** Whether the session may call the plugin's tool now (pinned, and `tools.call` by the roles). */
  mayCallTool(facts: AgentSessionFacts, tool: ToolGrant): Promise<boolean>;
  /** Refuses (ENOSPC) a write to a project over a storage limit (statewalker/statewalker-root#179). */
  admitWrite?(project: string): Promise<void>;
}

/** Who holds a capability, and where it acts. */
interface Holder {
  capability: string;
  user: string;
  project: string;
  /** An agent session's (or its tool's) facts; none for the user's own session. */
  agent?: AgentSessionFacts;
  grants: RoleGrant[];
}

const KEY = /^[A-Za-z0-9_-]{16,128}$/;
const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

export class DatabaseGate {
  readonly #o: DatabaseGateOptions;
  /** Changes to declarations, one at a time. */
  #declaring: Promise<unknown> = Promise.resolve();

  constructor(options: DatabaseGateOptions) {
    this.#o = options;
    options.sql.exec(`CREATE TABLE IF NOT EXISTS db_private (project TEXT NOT NULL,
      name TEXT NOT NULL, PRIMARY KEY (project, name))`);
  }

  async #holder(capability: string, project: string | undefined): Promise<Holder> {
    const { authority } = this.#o;
    const agent = await authority.agentSessionOf(capability).catch(() => undefined);
    const user = agent?.user ?? (await authority.userOfUserCapability(capability));
    const where = agent?.project ?? (typeof project === "string" ? project : "");
    if (agent && project !== undefined && project !== agent.project)
      throw codedError("EACCES", `an agent session acts in ${agent.project} only`);
    if (!where) throw codedError("EINVAL", "a database belongs to a project");
    const access = await this.#o.access(where, user).catch(() => ({ member: false, grants: [] }));
    if (!access.member) throw codedError("EACCES", `${user} is not a member of ${where}`);
    return {
      capability,
      user,
      project: where,
      ...(agent ? { agent } : {}),
      grants: access.grants,
    };
  }

  async #declared(project: string) {
    const text = await tryReadText(
      await this.#o.store,
      `/${project}/${this.#o.systemFolder}/${DATABASES_FILE}`,
    );
    const { databases, problems } = parseDatabases(text);
    if (problems.length) console.warn(`databases of ${project}: ${problems.join("; ")}`);
    return databases;
  }

  async #may(holder: Holder, action: DbPermission, database: string): Promise<boolean> {
    try {
      await this.#o.authority.authorizeDatabase(holder.capability, {
        action,
        database,
        project: holder.project,
        grants: holder.grants,
      });
      return true;
    } catch {
      return false;
    }
  }

  #backend(project: string, database: string) {
    return this.#o.backend(`${this.#o.workspace}/${project}/${database}`);
  }

  /** The holder's id mixed with its capability: what the backend knows the result or call by. */
  async #key(holder: Holder, id: unknown): Promise<string> {
    if (typeof id !== "string" || !KEY.test(id))
      throw codedError("EINVAL", "stream and request ids are 16 to 128 of [A-Za-z0-9_-]");
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${holder.capability}\n${id}`),
    );
    return hex(digest).slice(0, 48);
  }

  /**
   * The mode on one change of an agent session: allowed, refused (EACCES), or waiting on the
   * approval of exactly this action (unless the user granted it).
   */
  async #settle(
    holder: Holder,
    permission: DbPermission,
    database: string,
    action: DatabaseAction,
  ): Promise<void> {
    const facts = holder.agent;
    if (!facts) return;
    const decision = await this.#o.decide(facts, {
      area: "db",
      action: permission,
      target: database,
    });
    if (decision.verdict === "allow") return;
    if (decision.verdict === "deny")
      throw codedError(
        "EACCES",
        `may not ${permission} database '${database}': ${decision.reason}`,
      );
    const content = encodeDatabaseAction(action);
    const id = await approvalId(facts.session, "db", database, content);
    if (await this.#o.consume(facts, id)) return;
    throw approvalError({
      id,
      session: facts.session,
      project: holder.project,
      action: { method: "db", path: database, size: content.length },
      permission: `db.${permission}:${database}`,
      reason: decision.reason,
    });
  }

  /** Which database a name is for this holder, and what it may do there; ENOENT when absent. */
  async #reach(holder: Holder, database: unknown) {
    const own = privateDatabaseOf(database);
    if (own) {
      const tool = holder.agent?.tool;
      if (!tool || tool.plugin !== own.plugin || !holder.agent)
        throw codedError("ENOENT", `no database '${String(database)}'`);
      // The tool's right is read now, like every role.
      if (!(await this.#o.mayCallTool(holder.agent, tool)))
        throw codedError("EACCES", `may not call ${tool.plugin}/${tool.tool}`);
      this.#o.sql.exec(
        "INSERT OR IGNORE INTO db_private VALUES (?, ?)",
        holder.project,
        String(database),
      );
      return { name: String(database), private: true, read: true, write: true };
    }
    if (!isDatabaseName(database) || !(database in (await this.#declared(holder.project))))
      throw codedError("ENOENT", `no database '${String(database)}' in ${holder.project}`);
    const read = await this.#may(holder, "read", database);
    const write = await this.#may(holder, "write", database);
    if (!read && !write) throw codedError("EACCES", `may not use database '${database}'`);
    return { name: database, private: false, read, write };
  }

  /** One db-rpc call on a database, decided now. */
  async call(capability: string, req: DatabaseCall): Promise<unknown> {
    const method = req?.method;
    if (!DB_RPC_METHODS.includes(method))
      throw codedError("EINVAL", `no method '${String(method)}'`);
    const args = Array.isArray(req.args) ? req.args : [];
    const holder = await this.#holder(capability, req.project);
    const db = await this.#reach(holder, req.database);
    const backend = this.#backend(holder.project, db.name);
    const kindOf = async (
      op: "query" | "exec",
      sql: unknown,
      params?: unknown[],
    ): Promise<DbServerKind> => {
      if (typeof sql !== "string") throw codedError("EINVAL", "sql must be a string");
      if (db.private) {
        if (!isReadStatement(sql)) await this.#o.admitWrite?.(holder.project);
        return "write";
      }
      // Reads never wait on an approval: one the mode does not allow is refused.
      const readOnly = async (): Promise<DbServerKind> => {
        await this.#readable(holder, db.name);
        return "read";
      };
      if (isReadStatement(sql) || !db.write) return readOnly();
      await this.#o.admitWrite?.(holder.project);
      await this.#settle(holder, "write", db.name, {
        op,
        sql,
        ...(params !== undefined ? { params } : {}),
      });
      return "write";
    };
    const run = async () => {
      switch (method) {
        case "query": {
          const [sql, params, options] = args as [unknown, unknown, { streamId?: unknown }?];
          if (params !== undefined && params !== null && !Array.isArray(params))
            throw codedError("EINVAL", "params must be a list");
          const list = Array.isArray(params) ? params : undefined;
          const kind = await kindOf("query", sql, list);
          const id =
            options?.streamId === undefined
              ? crypto.randomUUID().replace(/-/g, "")
              : options.streamId;
          const result = (await backend.query(kind, sql as string, list, {
            streamId: await this.#key(holder, id),
          })) as { streamId: string; pages: number; rows: unknown[] };
          return { pages: result.pages, rows: result.rows, streamId: id };
        }
        case "readPage": {
          const [id, page] = args;
          return backend.readPage(await this.#key(holder, id), Number(page));
        }
        case "closeQuery":
          return backend.closeQuery(await this.#key(holder, args[0]));
        case "exec": {
          const [sql, options] = args as [unknown, { requestId?: unknown }?];
          const kind = await kindOf("exec", sql);
          return backend.exec(kind, sql as string, await this.#requestOptions(holder, options));
        }
        case "flush":
          return backend.flush(
            await this.#requestOptions(holder, args[0] as { requestId?: unknown } | undefined),
          );
      }
    };
    try {
      return await run();
    } catch (e) {
      throw coded(e);
    }
  }

  async #requestOptions(holder: Holder, options: { requestId?: unknown } | undefined) {
    return options?.requestId === undefined
      ? {}
      : { requestId: await this.#key(holder, options.requestId) };
  }

  async #readable(holder: Holder, database: string): Promise<void> {
    const facts = holder.agent;
    if (!facts) return;
    const decision = await this.#o.decide(facts, { area: "db", action: "read", target: database });
    if (decision.verdict !== "allow")
      throw codedError("EACCES", `may not read database '${database}': ${decision.reason}`);
  }

  /** Creates or drops a project database: `db.admin`, and for an agent the mode. */
  async manage(
    capability: string,
    req: { project?: string; database: string; op: "create" | "drop" },
  ): Promise<{ database: string; created?: true; dropped?: true }> {
    const holder = await this.#holder(capability, req.project);
    const name = req.database;
    if (req.op !== "create" && req.op !== "drop")
      throw codedError("EINVAL", "op is create or drop");
    if (!isDatabaseName(name))
      throw codedError("EINVAL", `'${String(name)}' is not a database name (one lowercase word)`);
    if (!(await this.#may(holder, "admin", name)))
      throw codedError("EACCES", `may not ${req.op} database '${name}'`);
    await this.#settle(holder, "admin", name, { op: req.op });
    const backend = this.#backend(holder.project, name);
    return this.#declare(async () => {
      const declared = await this.#declared(holder.project);
      const path = `/${holder.project}/${this.#o.systemFolder}/${DATABASES_FILE}`;
      const store = await this.#o.store;
      if (req.op === "create") {
        if (name in declared) throw codedError("EEXIST", `database '${name}' exists`);
        // Whatever an undeclared database left behind goes first: a new one starts empty.
        await backend.drop();
        declared[name] = { created: Date.now(), by: holder.user };
        await writeText(store, path, formatDatabases(declared));
        return { database: name, created: true as const };
      }
      if (!(name in declared))
        throw codedError("ENOENT", `no database '${name}' in ${holder.project}`);
      // Undeclared first, so no call reaches it while it goes.
      delete declared[name];
      await writeText(store, path, formatDatabases(declared));
      await backend.drop();
      return { database: name, dropped: true as const };
    });
  }

  #declare<T>(change: () => Promise<T>): Promise<T> {
    const next = this.#declaring.then(change, change);
    this.#declaring = next.catch(() => {});
    return next;
  }

  /** A project's declared databases the holder may use, with what it may do and their size. */
  async list(capability: string, project?: string): Promise<DatabaseView[]> {
    const holder = await this.#holder(capability, project);
    const views: DatabaseView[] = [];
    for (const name of Object.keys(await this.#declared(holder.project)).sort()) {
      const write = await this.#may(holder, "write", name);
      if (!write && !(await this.#may(holder, "read", name))) continue;
      const bytes = await this.#backend(holder.project, name).size();
      views.push({ name, access: write ? "write" : "read", bytes });
    }
    return views;
  }

  /**
   * Every database of the workspace and the bytes it takes, tool-private ones included: what the
   * storage meter counts against the workspace's limits (statewalker/statewalker-root#179).
   */
  async storage(): Promise<{ project: string; database: string; bytes: number }[]> {
    const store = await this.#o.store;
    const found: { project: string; database: string }[] = [];
    for await (const entry of store.list("/")) {
      if (entry.kind !== "directory" || entry.name === this.#o.systemFolder) continue;
      for (const database of Object.keys(await this.#declared(entry.name)))
        found.push({ project: entry.name, database });
    }
    for (const row of this.#o.sql
      .exec("SELECT project, name FROM db_private ORDER BY project, name")
      .toArray())
      found.push({ project: String(row.project), database: String(row.name) });
    const out = [];
    for (const { project, database } of found)
      out.push({ project, database, bytes: await this.#backend(project, database).size() });
    return out;
  }
}

/** A backend's error with a code: SQL errors and db-rpc's are the caller's (EINVAL, ENOENT). */
function coded(e: unknown): Error {
  const message = String((e as Error)?.message ?? e);
  if (/^E[A-Z]+:/.test(message)) return e as Error;
  if (/^UNKNOWN_STREAM\b/.test(message)) return codedError("ENOENT", message);
  if (/^(TOO_MANY_STREAMS|ABORTED)\b/.test(message)) return codedError("EBUSY", message);
  return codedError("EINVAL", message);
}
