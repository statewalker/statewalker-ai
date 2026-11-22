// One DO per database (statewalker/statewalker-root#81, built by #136), named
// `<workspace>/<project>/<database>`: its own SQLite, never the Workspace DO's, so a holder's SQL
// never sees the file store or the authority tables. It is a private backend: only its workspace's
// DO reaches it, after the gate decided the call. It serves its Db twice through db-rpc: a
// read-write server, and a read-only one whose every call runs in a transaction that is always
// rolled back (a holder with only `db.read`, or a statement taken for a read). An open result of
// several pages stays on the server that answered its first page.
import { DurableObject } from "cloudflare:workers";
import { codedError } from "@statewalker/ai-access";
import type { Db } from "@statewalker/db-api";
import { type DbRpcServer, newDbRpcServer } from "@statewalker/db-rpc";
import { newDoSqliteDb } from "@statewalker/db-sqlite-do";
import type { Env } from "./env.js";

/** Which of the two servers a call goes to. */
export type DbServerKind = "read" | "write";

/** Open results, at most, beside db-rpc's own bound per server. */
const MAX_OPEN = 512;

export class Database extends DurableObject<Env> {
  #db: Db;
  #servers: Record<DbServerKind, DbRpcServer>;
  /** The server holding each open result, by the result's (gate-chosen) stream id. */
  readonly #open = new Map<string, DbServerKind>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#db = newDoSqliteDb(ctx.storage as never);
    this.#servers = this.#serve();
  }

  #serve(): Record<DbServerKind, DbRpcServer> {
    return {
      write: newDbRpcServer({ db: this.#db }),
      read: newDbRpcServer({ db: this.#db, readOnly: true }),
    };
  }

  async query(
    kind: DbServerKind,
    sql: string,
    params: unknown[] | undefined,
    options: { streamId?: string },
  ) {
    const server = this.#servers[kind === "write" ? "write" : "read"];
    const result = await server.query(sql, params, options);
    if (result.pages > 1) {
      if (this.#open.size >= MAX_OPEN) {
        const [oldest] = this.#open.keys();
        if (oldest !== undefined) this.#open.delete(oldest);
      }
      this.#open.set(result.streamId, kind === "write" ? "write" : "read");
    }
    return result;
  }

  async readPage(streamId: string, pageId: number) {
    const kind = this.#open.get(streamId);
    if (!kind) throw codedError("ENOENT", "UNKNOWN_STREAM: no such open result");
    const page = await this.#servers[kind].readPage(streamId, pageId);
    return page;
  }

  async closeQuery(streamId: string) {
    const kind = this.#open.get(streamId);
    this.#open.delete(streamId);
    if (kind) await this.#servers[kind].closeQuery(streamId);
  }

  async exec(kind: DbServerKind, sql: string, options: { requestId?: string }) {
    return this.#servers[kind === "write" ? "write" : "read"].exec(sql, options);
  }

  async flush(options: { requestId?: string }) {
    return this.#servers.write.flush(options);
  }

  /** The bytes the database takes: what the storage meter counts (statewalker/statewalker-root#179). */
  async size(): Promise<number> {
    return this.ctx.storage.sql.databaseSize;
  }

  /** Drops the database: every table, view, index and trigger, and every open result. */
  async drop(): Promise<void> {
    this.#servers.write.close();
    this.#servers.read.close();
    this.#open.clear();
    // deleteAll drops the tables (their indexes and triggers with them); views stay, so they go
    // first. The platform's own objects (`_cf_*`) are not the holder's.
    const sql = this.ctx.storage.sql;
    const views = sql
      .exec(
        "SELECT name FROM sqlite_master WHERE type = 'view' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'",
      )
      .toArray()
      .map((r) => String(r.name));
    for (const name of views) sql.exec(`DROP VIEW IF EXISTS "${name.replace(/"/g, '""')}"`);
    await this.ctx.storage.deleteAll();
    this.#servers = this.#serve();
  }
}
