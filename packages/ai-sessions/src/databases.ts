// A project's databases over the session API (statewalker/statewalker-root#136): db-rpc's protocol
// on the workspace's gate, here carried for a client outside the deployment.
// - RPC: a WebSocket (the Worker's /v1/databases), msgpack frames through webrun-wire's
//   multiplexer, one port per connection serving the methods; the first call authenticates with
//   the access token, and every later call goes to the caller's User DO with it, checked each
//   time. Each db-rpc call names its project and database first, so `databasesRpcClient` gives a
//   `Db` per database whose large results arrive page by page.
// - REST: GET /v1/projects/<p>/databases lists them; POST .../<db>/query {sql, params?} answers
//   `{rows}`, written out page by page as the gate serves them; POST .../<db>/exec {sql} answers
//   `{done: true}`. Parameters over REST are JSON values (no BLOBs).
import { codedError, statusOf } from "@statewalker/ai-access";
import type { Db } from "@statewalker/db-api";
import { type DbRpc, newDbRpcClient } from "@statewalker/db-rpc";
import { msgpackCodec } from "@statewalker/webrun-msgpack";
import { methodsClient, overPipe, serveMethods } from "@statewalker/webrun-rpc";
import { messageTargetOverWebSocket, type WebSocketLike } from "@statewalker/webrun-streams-ws";
import type { DatabaseCall, DatabaseView, SessionApi } from "./api.js";
import { bearerOf, bodyOf } from "./rest.js";

const CHANNEL = "statewalker-ai/databases/v1";
const DB_METHODS = ["query", "readPage", "closeQuery", "exec", "flush"] as const;
const METHODS = ["authenticate", "listDatabases", ...DB_METHODS] as const;
/** A long statement may take a while; the channel's close still ends a call. */
const TIMEOUT_MS = 15 * 60_000;

type Channel = {
  authenticate(token: string): Promise<true>;
  listDatabases(project: string): Promise<{ databases: DatabaseView[] }>;
} & Record<(typeof DB_METHODS)[number], (...args: unknown[]) => Promise<unknown>>;

/**
 * Serves the databases on a WebSocket, for the caller whose access token the first call carries.
 * Every db-rpc call is `(project, database, ...the call's own arguments)`. Returns the teardown.
 */
export function serveDatabasesRpc(
  ws: WebSocketLike,
  open: (token: string) => SessionApi,
): () => void {
  const { target, signal } = messageTargetOverWebSocket(ws);
  const mux = overPipe(target, { codec: msgpackCodec, side: "responder", signal })((port) => {
    let api: SessionApi | undefined;
    const authenticated = () => {
      if (!api) throw codedError("EAUTH", "the first call carries the access token");
      return api;
    };
    const impl: Record<string, (...args: unknown[]) => Promise<unknown>> = {
      async authenticate(token) {
        if (api) throw codedError("EINVAL", "this channel is already authenticated");
        const opened = open(String(token ?? ""));
        await opened.me();
        api = opened;
        return true;
      },
      listDatabases: async (project) => authenticated().listDatabases(String(project ?? "")),
    };
    for (const method of DB_METHODS)
      impl[method] = async (project, database, ...args) =>
        authenticated().database({
          project: String(project ?? ""),
          database: String(database ?? ""),
          method,
          args,
        });
    serveMethods(port, impl, { channelName: CHANNEL, methods: METHODS, timeout: TIMEOUT_MS });
    return true;
  });
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    void Promise.resolve(mux)
      .then((m) => m.close())
      .catch(() => {});
  };
}

export interface DatabasesRpcConnection {
  listDatabases(project: string): Promise<{ databases: DatabaseView[] }>;
  /** One database of a project as a `Db` (db-rpc's client: large results page by page). */
  database(project: string, database: string): Db;
  /** db-rpc's calls themselves on one database, for clients that drive results by hand. */
  rpc(project: string, database: string): DbRpc;
  close(): void;
}

/** A project's databases over a WebSocket to the deployment's /v1/databases, with an access token. */
export async function databasesRpcClient(
  ws: WebSocketLike,
  token: string,
): Promise<DatabasesRpcConnection> {
  const { target, signal } = messageTargetOverWebSocket(ws);
  const mux = await overPipe(target, { codec: msgpackCodec, side: "initiator", signal })();
  const port = await mux.openPort({ kind: "methods" });
  const channel = methodsClient<Channel>(port, {
    channelName: CHANNEL,
    methods: METHODS,
    timeout: TIMEOUT_MS,
  });
  await channel.authenticate(token);
  const dbs = new Map<string, Db>();
  const rpc = (project: string, database: string): DbRpc => {
    const call =
      (method: (typeof DB_METHODS)[number]) =>
      (...args: unknown[]) =>
        channel[method](project, database, ...args) as never;
    return {
      query: call("query"),
      readPage: call("readPage"),
      closeQuery: call("closeQuery"),
      exec: call("exec"),
      flush: call("flush"),
    };
  };
  return {
    listDatabases: (project) => channel.listDatabases(project),
    rpc,
    database(project, database) {
      const key = JSON.stringify([project, database]);
      let db = dbs.get(key);
      if (!db) {
        db = newDbRpcClient({ rpc: rpc(project, database) });
        dbs.set(key, db);
      }
      return db;
    },
    close: () => {
      for (const db of dbs.values()) void db.close().catch(() => {});
      void mux.close();
      ws.close();
    },
  };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

/** JSON of rows: big integers as text, BLOBs as base64 text. */
const rowsJson = (rows: unknown[]) =>
  JSON.stringify(rows, (_key, value) => {
    if (typeof value === "bigint") return value.toString();
    if (value instanceof Uint8Array) {
      let bin = "";
      for (const b of value) bin += String.fromCharCode(b);
      return btoa(bin);
    }
    return value;
  }).slice(1, -1);

/**
 * Answers a request to the REST routes of the databases (/v1/projects/<p>/databases...), or
 * returns undefined when it is not one of them.
 */
export async function handleDatabasesRest(
  request: Request,
  open: (token: string) => SessionApi,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "v1" || parts[1] !== "projects" || parts[3] !== "databases") return undefined;
  if (parts.length !== 4 && parts.length !== 6) return undefined;
  try {
    const project = decodeURIComponent(String(parts[2]));
    const api = open(bearerOf(request));
    if (parts.length === 4) {
      if (request.method !== "GET") return undefined;
      return json(await api.listDatabases(project));
    }
    const database = decodeURIComponent(String(parts[4]));
    const op = parts[5];
    if (request.method !== "POST" || (op !== "query" && op !== "exec")) return undefined;
    const body = await bodyOf(request);
    if (typeof body.sql !== "string") throw codedError("EINVAL", "sql must be a string");
    const call = (method: DatabaseCall["method"], args: unknown[]) =>
      api.database({ project, database, method, args });
    if (op === "exec") {
      await call("exec", [body.sql, { requestId: crypto.randomUUID().replace(/-/g, "") }]);
      return json({ done: true });
    }
    if (body.params !== undefined && !Array.isArray(body.params))
      throw codedError("EINVAL", "params must be a list");
    const streamId = crypto.randomUUID().replace(/-/g, "");
    // The first page answers (or refuses) before the response starts; the rest are read as the
    // body is written, one page at a time.
    const first = (await call("query", [body.sql, body.params ?? [], { streamId }])) as {
      pages: number;
      rows: unknown[];
    };
    const enc = new TextEncoder();
    let page = 0;
    let written = first.rows.length > 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(`{"rows":[${rowsJson(first.rows)}`));
      },
      async pull(controller) {
        try {
          page += 1;
          if (page >= first.pages) {
            controller.enqueue(enc.encode("]}"));
            controller.close();
            if (first.pages > 1) await call("closeQuery", [streamId]).catch(() => {});
            return;
          }
          const next = (await call("readPage", [streamId, page])) as { rows: unknown[] };
          if (next.rows.length) {
            controller.enqueue(enc.encode(`${written ? "," : ""}${rowsJson(next.rows)}`));
            written = true;
          }
        } catch (e) {
          // Headers are gone: the body ends malformed, so the client sees the failure.
          controller.error(e);
          await call("closeQuery", [streamId]).catch(() => {});
        }
      },
      async cancel() {
        await call("closeQuery", [streamId]).catch(() => {});
      },
    });
    return new Response(stream, { headers: { "content-type": "application/json" } });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, statusOf(e));
  }
}
