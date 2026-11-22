// Databases, the environment's eighth part (statewalker/statewalker-root#81, built by #136): named
// SQLite databases belong to a project and are declared in its system folder (`.system/databases`);
// a plugin's tools may keep tool-private ones, named `<plugin>:<name>`, which agents never see.
// Holders reach a database only through the gate, as db-rpc's protocol (`DB_RPC_METHODS`): a call
// with only `db.read` runs on a read-only server (a transaction always rolled back), a write with
// `db.write` on the read-write one, under the mode for agents.
import { codedError } from "@statewalker/ai-access";

/** The declarations file in each project's system folder. */
export const DATABASES_FILE = "databases";

/** db-rpc's protocol, as the gate serves it to every holder. */
export const DB_RPC_METHODS = ["query", "readPage", "closeQuery", "exec", "flush"] as const;
export type DbRpcMethod = (typeof DB_RPC_METHODS)[number];

/** What a project's declarations file says of one database (room for later settings). */
export interface DatabaseDeclaration {
  /** When it was created (epoch ms), and by whom. */
  created?: number;
  by?: string;
}

/** A project database's name: one lowercase word, so it can't spell a path or a plugin's name. */
const DATABASE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** A plugin's name, as definitions name it. */
const PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const isDatabaseName = (name: unknown): name is string =>
  typeof name === "string" && DATABASE_NAME.test(name);

/** A tool-private database's plugin and name (`<plugin>:<name>`), or undefined for any other. */
export function privateDatabaseOf(name: unknown): { plugin: string; name: string } | undefined {
  if (typeof name !== "string") return undefined;
  const at = name.indexOf(":");
  if (at < 0) return undefined;
  const plugin = name.slice(0, at);
  const own = name.slice(at + 1);
  return PLUGIN_NAME.test(plugin) && DATABASE_NAME.test(own) ? { plugin, name: own } : undefined;
}

/**
 * A project's declared databases from its declarations file: JSON `{"<name>": {...}}`. Missing
 * text declares none; unreadable text and names that are not database names are reported and
 * declare nothing.
 */
export function parseDatabases(text: string | undefined): {
  databases: Record<string, DatabaseDeclaration>;
  problems: string[];
} {
  const databases: Record<string, DatabaseDeclaration> = {};
  const problems: string[] = [];
  if (text === undefined || !text.trim()) return { databases, problems };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { databases, problems: ["the declarations are not JSON"] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return { databases, problems: ["the declarations are an object of databases"] };
  for (const [name, value] of Object.entries(parsed)) {
    if (!isDatabaseName(name)) {
      problems.push(`'${name}' is not a database name`);
      continue;
    }
    const v = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const { created, by } = v as Record<string, unknown>;
    databases[name] = {
      ...(typeof created === "number" ? { created } : {}),
      ...(typeof by === "string" ? { by } : {}),
    };
  }
  return { databases, problems };
}

/** The declarations file's text for these databases, names sorted. */
export function formatDatabases(databases: Record<string, DatabaseDeclaration>): string {
  const sorted = Object.fromEntries(
    Object.keys(databases)
      .sort()
      .map((name) => [name, databases[name]]),
  );
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

const WRITES = /\b(insert|update|delete|replace|create|drop|alter)\b/i;

/**
 * Whether a statement reads only, by its first keyword (comments and parentheses skipped). It only
 * picks the server: a statement taken for a read runs on the read-only server, where a write it
 * hides is rolled back, so a wrong guess never writes; one taken for a write asks under the mode.
 */
export function isReadStatement(sql: string): boolean {
  let s = String(sql);
  for (;;) {
    const before = s;
    s = s.replace(/^[\s(]+/, "");
    if (s.startsWith("--")) s = s.slice(s.indexOf("\n") < 0 ? s.length : s.indexOf("\n"));
    else if (s.startsWith("/*")) s = s.slice(s.indexOf("*/") < 0 ? s.length : s.indexOf("*/") + 2);
    if (s === before) break;
  }
  const head = /^[A-Za-z]+/.exec(s)?.[0]?.toLowerCase();
  if (head === "select" || head === "values" || head === "explain") return true;
  // A common table expression may lead to any statement.
  return head === "with" && !WRITES.test(s);
}

/** One database action an agent took, as an approval stores it and runs it again. */
export interface DatabaseAction {
  op: "query" | "exec" | "create" | "drop";
  sql?: string;
  params?: unknown[];
}

const toBase64 = (bytes: Uint8Array) => {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** A parameter as JSON, BLOBs and big integers tagged so they come back as they were. */
function paramToJson(value: unknown): unknown {
  if (value instanceof Uint8Array) return { $bytes: toBase64(value) };
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (value instanceof Date) return value.toISOString();
  return value;
}

function paramFromJson(value: unknown): unknown {
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (typeof v.$bytes === "string") return fromBase64(v.$bytes);
    if (typeof v.$bigint === "string") return BigInt(v.$bigint);
  }
  return value;
}

/**
 * An action's exact bytes: what keys its approval (with the session and the database) and what
 * the agent session stores to run it again.
 */
export function encodeDatabaseAction(action: DatabaseAction): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      op: action.op,
      ...(action.sql !== undefined ? { sql: String(action.sql) } : {}),
      ...(action.params !== undefined ? { params: action.params.map(paramToJson) } : {}),
    }),
  );
}

export function decodeDatabaseAction(bytes: Uint8Array): DatabaseAction {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw codedError("EINVAL", "not a database action");
  }
  const op = parsed?.op;
  if (op !== "query" && op !== "exec" && op !== "create" && op !== "drop")
    throw codedError("EINVAL", "not a database action");
  return {
    op,
    ...(typeof parsed.sql === "string" ? { sql: parsed.sql } : {}),
    ...(Array.isArray(parsed.params) ? { params: parsed.params.map(paramFromJson) } : {}),
  };
}
