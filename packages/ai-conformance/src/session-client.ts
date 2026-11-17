// The session API as a client sees it, over REST. Scenarios are written against `SessionClient`,
// so the same scenario runs over every transport (REST here, RPC in ./rpc-client.ts).
import type { Deployment } from "./deployment.js";

/** An item of a turn, as the session API lists it. */
export interface Item {
  seq: number;
  id: string;
  turn: string;
  kind: "message" | "tool_call" | "tool_result";
  role?: "user" | "assistant";
  text?: string;
  callId?: string;
  name?: string;
  args?: unknown;
  output?: string;
  isError?: boolean;
}

export interface UserSession {
  id: string;
  user: string;
  workspace: string;
}

export interface AgentSession {
  id: string;
  project: string;
  agent: string;
}

export interface Turn {
  id: string;
  session: string;
  status: string;
  items: Item[];
}

export interface SessionClient {
  me(): Promise<UserSession>;
  startSession(req: { project: string; agent: string }): Promise<AgentSession>;
  sendMessage(sessionId: string, req: { content: string }): Promise<Turn>;
  listItems(sessionId: string): Promise<{ items: Item[] }>;
}

/** A refusal by the session API; `status` is the HTTP status REST answers with. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function answer<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, String(body.error ?? res.statusText));
  return body as T;
}

export function restClient(deployment: Deployment, token: string): SessionClient {
  const call = <T>(method: string, path: string, body?: unknown) =>
    deployment
      .fetch(path, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      .then((res) => answer<T>(res));
  return {
    me: () => call("GET", "/v1/me"),
    startSession: (req) => call("POST", "/v1/sessions", req),
    sendMessage: (id, req) => call("POST", `/v1/sessions/${encodeURIComponent(id)}/messages`, req),
    listItems: (id) => call("GET", `/v1/sessions/${encodeURIComponent(id)}/items`),
  };
}

/**
 * An access token from the deployment's issuer, through its test-only login route (it stands in
 * for an identity provider and exists only where the deployment's `DEV_LOGIN` var is set).
 */
export async function login(
  deployment: Deployment,
  user: string,
  options: { ttlMs?: number } = {},
): Promise<string> {
  const res = await deployment.fetch("/v1/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user, ...options }),
  });
  return (await answer<{ token: string }>(res)).token;
}

/** Writes fixture files into the deployment's workspace (test-only, behind `ADMIN_KEY`). */
export async function seed(
  deployment: Deployment,
  adminKey: string,
  files: Record<string, string>,
): Promise<void> {
  const res = await deployment.fetch("/admin/seed", {
    method: "POST",
    headers: { authorization: `Bearer ${adminKey}`, "content-type": "application/json" },
    body: JSON.stringify({ files }),
  });
  await answer(res);
}
