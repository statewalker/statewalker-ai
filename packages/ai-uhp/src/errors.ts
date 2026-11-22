// UHP's error envelope (Errors §1, UHP 2026-10-19): `{error: {type, code, message, param, detail}}`
// on every non-2xx answer, with a closed set of codes; the harness's own codes carry the vendor
// prefix `statewalker_`. A coded error of the session API is mapped by its code, a 404 naming what
// the route looked for (UHP answers 404, never 403, for what is outside the caller's scope).
import { codeOf, retryAfterOf } from "@statewalker/ai-access";

const TYPES: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "invalid_request_error",
  409: "invalid_request_error",
  410: "invalid_request_error",
  422: "invalid_request_error",
  429: "rate_limit_error",
};

/** A refusal as UHP names it. */
export class UhpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly param: string | null;
  readonly detail: Record<string, unknown> | null;

  constructor(
    status: number,
    code: string,
    message: string,
    options: { param?: string; detail?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.param = options.param ?? null;
    this.detail = options.detail ?? null;
  }
}

export const uhpError = (
  status: number,
  code: string,
  message: string,
  options?: { param?: string; detail?: Record<string, unknown> },
) => new UhpError(status, code, message, options);

/** A coded error's message without its code (`ENOENT: no such turn` → `no such turn`). */
export const messageOf = (e: unknown): string =>
  String((e as Error)?.message ?? e).replace(/^E[A-Z]+:\s*/, "");

/**
 * The UHP refusal for an error of the session API: `notFound` names the code of a 404 (what the
 * route looked for), `busy` the code of a 409.
 */
export function toUhpError(
  e: unknown,
  context: { notFound?: string; busy?: string } = {},
): UhpError {
  if (e instanceof UhpError) return e;
  const message = messageOf(e);
  switch (codeOf(e)) {
    case "EAUTH":
      return uhpError(401, "invalid_credential", message);
    case "EACCES":
    // Outside the caller's scope: 404, never 403 (Architecture §5).
    case "ENOENT":
      return uhpError(404, context.notFound ?? "statewalker_not_found", message);
    case "EINVAL":
      return uhpError(400, "invalid_input", message);
    case "EBUSY":
    case "EEXIST":
      return uhpError(409, context.busy ?? "session_busy", message);
    case "ELIMIT": {
      const retry = retryAfterOf(e);
      return uhpError(429, "rate_limited", message, {
        ...(retry !== undefined ? { detail: { retry_after_ms: retry * 1000 } } : {}),
      });
    }
    case "ENOSPC":
      return uhpError(429, "quota_exhausted", message);
    case "ENOSYS":
      return uhpError(501, "statewalker_not_implemented", message);
    default:
      return uhpError(500, "statewalker_server_error", "the server failed");
  }
}

/** The JSON answer of a refusal, with its version header. */
export function errorResponse(e: UhpError, version: string): Response {
  const retry = e.status === 429 ? e.detail?.retry_after_ms : undefined;
  return new Response(
    JSON.stringify({
      error: {
        type: TYPES[e.status] ?? "server_error",
        code: e.code,
        message: e.message,
        param: e.param,
        detail: e.detail,
      },
    }),
    {
      status: e.status,
      headers: {
        "content-type": "application/json",
        "uhp-version": version,
        ...(typeof retry === "number" ? { "retry-after": String(Math.ceil(retry / 1000)) } : {}),
      },
    },
  );
}
