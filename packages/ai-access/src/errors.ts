// Errors that cross the harness's boundaries (Durable Object RPC, webrun-rpc, REST) keep their
// meaning in the message alone: it starts with the code, so any hop can rebuild `code` from it.

export type ErrorCode =
  | "EAUTH" // no valid access token (REST: 401)
  | "EACCES" // the caller may not do this (403)
  | "ENOENT" // no such thing, or not visible to the caller (404)
  | "EINVAL" // a malformed request (400)
  | "EBUSY" // refused in the thing's current state: running, archived, already ended (409)
  | "EEXIST" // it exists already (409)
  | "ELIMIT" // a limit refused it (statewalker/statewalker-root#179): too many, for now (429)
  | "ENOSPC" // a storage limit refused a write; reads and deletes still work (507)
  | "E2BIG" // a request's body or payload is over its cap (413, statewalker/statewalker-root#207)
  | "ENOSYS" // not implemented (501)
  | "EIO"; // anything else (500)

export interface CodedError extends Error {
  code: ErrorCode;
}

export function codedError(code: ErrorCode, message: string): CodedError {
  const err = new Error(`${code}: ${message}`) as CodedError;
  err.code = code;
  return err;
}

const CODES = new Set<string>([
  "EAUTH",
  "EACCES",
  "ENOENT",
  "EINVAL",
  "EBUSY",
  "EEXIST",
  "ELIMIT",
  "ENOSPC",
  "E2BIG",
  "ENOSYS",
  "EIO",
]);

/** The code of an error, from `code` or the message's prefix; "EIO" when it carries none. */
export function codeOf(e: unknown): ErrorCode {
  const own = (e as { code?: unknown })?.code;
  if (typeof own === "string" && CODES.has(own)) return own as ErrorCode;
  const prefix = /^(E[A-Z0-9]+):/.exec(String((e as Error)?.message ?? e))?.[1];
  return prefix && CODES.has(prefix) ? (prefix as ErrorCode) : "EIO";
}

const STATUS: Record<ErrorCode, number> = {
  EAUTH: 401,
  EACCES: 403,
  ENOENT: 404,
  EINVAL: 400,
  EBUSY: 409,
  EEXIST: 409,
  ELIMIT: 429,
  ENOSPC: 507,
  E2BIG: 413,
  ENOSYS: 501,
  EIO: 500,
};

/** The HTTP status REST answers an error with. */
export const statusOf = (e: unknown): number => STATUS[codeOf(e)];

/** Seconds until a refused call may succeed, from a message's `retry after <n> s`. */
export function retryAfterOf(e: unknown): number | undefined {
  const m = /retry after (\d+) s\b/.exec(String((e as Error)?.message ?? e));
  return m ? Number(m[1]) : undefined;
}
