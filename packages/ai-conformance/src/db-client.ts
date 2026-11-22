// A project's databases as a client sees them over the session API (statewalker/statewalker-root#136):
// by REST (routes under /v1/projects/<p>/databases) or by RPC (db-rpc's protocol on the WebSocket at
// /v1/databases, so a large result arrives page by page). Scenarios are written against
// `DbClient`, so the same scenario runs over both.
import { databasesRpcClient } from "@statewalker/ai-sessions";
import type { Deployment } from "./deployment.js";
import { ApiError } from "./session-client.js";

/** One database of a project, as the caller sees it listed. */
export interface DatabaseView {
  name: string;
  /** What the caller's roles let them do there. */
  access: "read" | "write";
  /** The bytes it takes, as the storage meter counts them. */
  bytes: number;
}

/** A project's databases for one caller: listing, and one database's `Db`. */
export interface DbClient {
  listDatabases(project: string): Promise<{ databases: DatabaseView[] }>;
  query<T = Record<string, unknown>>(
    project: string,
    database: string,
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
  exec(project: string, database: string, sql: string): Promise<void>;
  close(): void;
}

/** Over RPC: db-rpc's calls themselves, for scenarios that drive results by hand. */
export interface RpcDbClient extends DbClient {
  rpc(project: string, database: string): DbRpcCalls;
}

/** db-rpc's protocol, as the gate serves it. */
export interface DbRpcCalls {
  query(
    sql: string,
    params?: unknown[],
    options?: { streamId?: string },
  ): Promise<{ streamId: string; pages: number; rows: Record<string, unknown>[] }>;
  readPage(
    streamId: string,
    pageId: number,
  ): Promise<{ rows: Record<string, unknown>[]; done: boolean }>;
  closeQuery(streamId: string): Promise<void>;
  exec(sql: string, options?: { requestId?: string }): Promise<void>;
  flush(options?: { requestId?: string }): Promise<void>;
}

async function answer<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, String(body.error ?? res.statusText));
  return body as T;
}

const base = (project: string) => `/v1/projects/${encodeURIComponent(project)}/databases`;

/** The databases over REST. */
export function restDb(deployment: Deployment, token: string): DbClient {
  const post = (path: string, body: unknown) =>
    deployment.fetch(path, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return {
    listDatabases: async (project) =>
      answer(
        await deployment.fetch(base(project), { headers: { authorization: `Bearer ${token}` } }),
      ),
    async query(project, database, sql, params) {
      const res = await post(`${base(project)}/${encodeURIComponent(database)}/query`, {
        sql,
        ...(params ? { params } : {}),
      });
      return (await answer<{ rows: never[] }>(res)).rows;
    },
    async exec(project, database, sql) {
      await answer(await post(`${base(project)}/${encodeURIComponent(database)}/exec`, { sql }));
    },
    close() {},
  };
}

interface ClientSocket {
  accept(): void;
  close(code?: number, reason?: string): void;
}

/** The databases over RPC: db-rpc's protocol on a WebSocket to /v1/databases. */
export async function rpcDb(deployment: Deployment, token: string): Promise<RpcDbClient> {
  const res = await deployment.fetch("/v1/databases", { headers: { upgrade: "websocket" } });
  const ws = (res as Response & { webSocket?: ClientSocket | null }).webSocket;
  if (res.status !== 101 || !ws) throw new ApiError(res.status, "the deployment refused RPC");
  ws.accept();
  const connection = await databasesRpcClient(ws as never, token);
  const refusal = (e: unknown): never => {
    const message = String((e as Error)?.message ?? e);
    const code = /^(E[A-Z]+)\b/.exec(message)?.[1];
    const status =
      { EAUTH: 401, EACCES: 403, ENOENT: 404, EINVAL: 400, EEXIST: 409, EBUSY: 409 }[code ?? ""] ??
      500;
    throw new ApiError(status, message);
  };
  return {
    listDatabases: (project) => connection.listDatabases(project).catch(refusal),
    query: (project, database, sql, params) =>
      connection.database(project, database).query(sql, params).catch(refusal) as never,
    exec: (project, database, sql) =>
      connection.database(project, database).exec(sql).catch(refusal),
    rpc(project, database) {
      const raw = connection.rpc(project, database);
      const wrap =
        <A extends unknown[], R>(f: (...a: A) => Promise<R>) =>
        (...a: A) =>
          f(...a).catch(refusal);
      return {
        query: wrap(raw.query) as never,
        readPage: wrap(raw.readPage) as never,
        closeQuery: wrap(raw.closeQuery),
        exec: wrap(raw.exec) as never,
        flush: wrap(raw.flush) as never,
      };
    },
    close: () => connection.close(),
  };
}

const admin = async <T>(deployment: Deployment, adminKey: string, path: string, body: unknown) =>
  answer<T>(
    await deployment.fetch(path, {
      method: "POST",
      headers: { authorization: `Bearer ${adminKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

/** One database call a plugin tool of an agent session makes. */
export interface ToolDbCall {
  plugin: string;
  tool: string;
  database: string;
  op: "query" | "exec";
  sql: string;
  params?: unknown[];
}

/**
 * Runs one database call as a plugin tool of an agent session would, with the capability the
 * workspace narrows for that tool (test-only, behind `ADMIN_KEY`, until tool scripts run).
 */
export async function toolDb(
  deployment: Deployment,
  adminKey: string,
  sessionId: string,
  call: ToolDbCall,
): Promise<{ rows?: Record<string, unknown>[] }> {
  return admin(
    deployment,
    adminKey,
    `/admin/sessions/${encodeURIComponent(sessionId)}/tool-db`,
    call,
  );
}

/**
 * Every database of a workspace and the bytes it takes, tool-private ones included: what the
 * storage meter counts (test-only, behind `ADMIN_KEY`).
 */
export async function databaseStorage(
  deployment: Deployment,
  adminKey: string,
  workspace = "default",
): Promise<{ project: string; database: string; bytes: number }[]> {
  const { databases } = await admin<{
    databases: { project: string; database: string; bytes: number }[];
  }>(
    deployment,
    adminKey,
    `/admin/workspaces/${encodeURIComponent(workspace)}/database-storage`,
    {},
  );
  return databases;
}
