// The harness's database tools (statewalker/statewalker-root#81, #136): an agent session lists its
// project's databases, queries and writes them, and (owners) creates and drops them, every call at
// the Workspace DO's gate with the session's capability. A result reaches the tool page by page
// (db-rpc's client over the gate), and a write the mode asks about ends the turn waiting on an
// approval of exactly that action, which the user's answer runs again through the gate. The model
// calls them `db_list`, `db_query`, `db_exec`, `db_create` and `db_drop` (tool names hold no dots).
import { type ApprovalRequest, codedError } from "@statewalker/ai-access";
import {
  approvalOf,
  type DatabaseAction,
  decodeDatabaseAction,
  encodeDatabaseAction,
  type StoredCall,
} from "@statewalker/ai-environment";
import type { HostTool } from "@statewalker/ai-flue";
import type { Db } from "@statewalker/db-api";
import { newDbRpcClient } from "@statewalker/db-rpc";
import type { DatabaseCall, DatabaseView } from "./database-gate.js";

export const DB_TOOLS = ["db_list", "db_query", "db_exec", "db_create", "db_drop"] as const;

/** What the tools need of the host: the gate, reached with the session's capability. */
export interface DatabaseHost {
  call(req: DatabaseCall): Promise<unknown>;
  manage(req: { database: string; op: "create" | "drop" }): Promise<unknown>;
  list(): Promise<DatabaseView[]>;
}

/** One database of the session's project, as a `Db` whose every call goes through the gate. */
export function databaseOf(host: DatabaseHost, database: string): Db {
  const call =
    (method: DatabaseCall["method"]) =>
    (...args: unknown[]) =>
      host.call({ database, method, args }) as never;
  return newDbRpcClient({
    rpc: {
      query: call("query"),
      readPage: call("readPage"),
      closeQuery: call("closeQuery"),
      exec: call("exec"),
      flush: call("flush"),
    },
  });
}

/** Rows as the model reads them: JSON, big integers as text and BLOBs by their size. */
export const rowsText = (rows: unknown): string =>
  JSON.stringify(rows, (_key, value) =>
    typeof value === "bigint"
      ? value.toString()
      : value instanceof Uint8Array
        ? `<${value.length} bytes>`
        : value,
  );

/** Runs one database action through the gate: rows for a query, nothing for the rest. */
export async function runDatabaseAction(
  host: DatabaseHost,
  database: string,
  action: DatabaseAction,
): Promise<unknown> {
  if (action.op === "create" || action.op === "drop")
    return host.manage({ database, op: action.op });
  const db = databaseOf(host, database);
  try {
    if (action.op === "query") return await db.query(String(action.sql), action.params);
    await db.exec(String(action.sql));
    return null;
  } finally {
    await db.close();
  }
}

/** Runs a stored database action again (an approved one): `{$approval}` if the gate still asks. */
export async function runStoredDatabaseCall(host: DatabaseHost, call: StoredCall) {
  try {
    return await runDatabaseAction(
      host,
      call.path,
      decodeDatabaseAction(call.content ?? new Uint8Array()),
    );
  } catch (e) {
    const request = approvalOf(e);
    if (request) return { $approval: request };
    throw e;
  }
}

const NAME = { type: "string", description: "The database's name in the project." };

/** The database tools of one session. */
export function databaseTools(
  host: DatabaseHost,
  onApproval: (request: ApprovalRequest, call: StoredCall) => void,
): HostTool[] {
  let waitingOn: ApprovalRequest | undefined;
  const act = async (database: unknown, action: DatabaseAction) => {
    if (typeof database !== "string" || !database)
      throw codedError("EINVAL", "database must be a database's name");
    // A turn waiting on an approval runs no further change: it ends at the pending call.
    if (waitingOn) throw new Error(`waiting on the user's approval ${waitingOn.id}`);
    try {
      return await runDatabaseAction(host, database, action);
    } catch (e) {
      const request = approvalOf(e);
      if (!request) throw e;
      waitingOn = request;
      onApproval(request, { method: "db", path: database, content: encodeDatabaseAction(action) });
      throw new Error(`waiting on the user's approval ${request.id}: ${request.reason}`);
    }
  };
  const tool = (
    name: (typeof DB_TOOLS)[number],
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    run: (args: Record<string, unknown>) => Promise<string>,
  ): HostTool => ({
    name,
    description,
    parameters: { type: "object", properties, required, additionalProperties: false },
    async execute(args) {
      try {
        return { output: await run(args), isError: false };
      } catch (e) {
        return { output: String((e as Error)?.message ?? e), isError: true };
      }
    },
  });
  const sql = { type: "string", description: "One SQLite statement." };
  return [
    tool("db_list", "Lists the project's databases you may use.", {}, [], async () =>
      JSON.stringify(await host.list()),
    ),
    tool(
      "db_query",
      "Runs one SQL statement on a project database and answers its rows as JSON.",
      { database: NAME, sql, params: { type: "array", description: "Values for its ? marks." } },
      ["database", "sql"],
      async ({ database, sql, params }) => {
        if (params !== undefined && !Array.isArray(params))
          throw codedError("EINVAL", "params must be a list");
        return rowsText(
          await act(database, {
            op: "query",
            sql: String(sql),
            ...(params ? { params: params as unknown[] } : {}),
          }),
        );
      },
    ),
    tool(
      "db_exec",
      "Runs SQL statements that answer no rows (DDL, DML) on a project database.",
      { database: NAME, sql: { type: "string", description: "SQLite statements." } },
      ["database", "sql"],
      async ({ database, sql }) => {
        await act(database, { op: "exec", sql: String(sql) });
        return "done";
      },
    ),
    tool(
      "db_create",
      "Creates a database in the project (project owners).",
      { database: NAME },
      ["database"],
      async ({ database }) => JSON.stringify(await act(database, { op: "create" })),
    ),
    tool(
      "db_drop",
      "Drops a database of the project and everything in it (project owners).",
      { database: NAME },
      ["database"],
      async ({ database }) => JSON.stringify(await act(database, { op: "drop" })),
    ),
  ];
}
