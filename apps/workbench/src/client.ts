// The workbench's client of the session API (statewalker/statewalker-root#111): REST and the
// server-sent event stream, over any `fetch` (the harness in this page, or a deployment's URL).
// The workbench reaches the harness only through it.

/** A request to a deployment; `path` is resolved against its origin. */
export type DeploymentFetch = (path: string, init?: RequestInit) => Promise<Response>;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface Item {
  seq: number;
  id: string;
  turn: string;
  kind: string;
  role?: "user" | "assistant";
  text?: string;
  name?: string;
  args?: unknown;
  output?: string;
  isError?: boolean;
  approval?: string;
}

export interface Turn {
  id: string;
  session_id: string;
  status: string;
  error?: string;
  stop_reason?: { type: string; message?: string; approval_ids?: string[] };
  items: Item[];
}

export interface Accepted {
  turn_id: string;
  session_id: string;
  stream_url: string;
  offset: number;
}

export interface SessionView {
  id: string;
  project: string;
  agent: string;
  status?: string;
}

export interface FileEntry {
  name: string;
  path: string;
  kind: "file" | "directory";
  size?: number;
}

export interface Approval {
  id: string;
  session: string;
  project: string;
  status: string;
  permission: string;
  reason: string;
  action: { method: string; path: string; target?: string };
}

/** The terminal events of a turn on its event stream. */
const TERMINAL = new Set([
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "turn.interrupted",
  "turn.waiting",
  "turn.incomplete",
]);

async function answer<T>(res: Response): Promise<T> {
  const text = await res.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, String(body?.error?.message ?? body?.error ?? text));
  return body as T;
}

interface Frame {
  id?: string;
  event?: string;
  data?: string;
}

async function* frames(body: ReadableStream<Uint8Array>): AsyncGenerator<Frame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const frame: Frame = {};
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) continue;
          const i = line.indexOf(":");
          const field = i < 0 ? line : line.slice(0, i);
          const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
          if (field === "data")
            frame.data = frame.data === undefined ? value : `${frame.data}\n${value}`;
          else if (field === "id" || field === "event") frame[field] = value;
        }
        yield frame;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Signs a user in where the deployment allows its development login (a page of one's own). */
export async function devLogin(fetch: DeploymentFetch, user: string): Promise<string> {
  const res = await fetch("/v1/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user }),
  });
  return (await answer<{ token: string }>(res)).token;
}

export type SessionClient = ReturnType<typeof sessionClient>;

/** The session API for the holder of `token`. */
export function sessionClient(fetch: DeploymentFetch, token: string) {
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const call = <T>(method: string, path: string, body?: unknown) =>
    fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then((res) => answer<T>(res));
  const s = (id: string) => `/v1/sessions/${encodeURIComponent(id)}`;
  const filePath = (path: string) =>
    `/v1/files/${path.split("/").filter(Boolean).map(encodeURIComponent).join("/")}`;
  return {
    me: () => call<{ user: string; mode: string }>("GET", "/v1/me"),
    startSession: (req: { project: string; agent?: string; model?: string }) =>
      call<SessionView>("POST", "/v1/sessions", req),
    listSessions: () => call<{ sessions: SessionView[] }>("GET", "/v1/sessions"),
    postMessage: (id: string, content: string) =>
      call<Accepted>("POST", `${s(id)}/messages`, { content }),
    cancelTurn: (id: string) => call<unknown>("POST", `/v1/turns/${encodeURIComponent(id)}/cancel`),
    /**
     * Follows a turn's event stream: each item as it is created, then the turn as it ended. The
     * stream ends with the turn's terminal event.
     */
    async *follow(accepted: Accepted): AsyncGenerator<{ item: Item } | { turn: Turn }> {
      const res = await fetch(accepted.stream_url, { headers });
      if (!res.ok || !res.body) await answer(res);
      for await (const frame of frames(res.body as ReadableStream<Uint8Array>)) {
        if (!frame.event || frame.data === undefined) continue;
        const data = JSON.parse(frame.data);
        if (frame.event === "item.created" && data?.turn === accepted.turn_id) yield { item: data };
        else if (TERMINAL.has(frame.event) && data?.id === accepted.turn_id) {
          yield { turn: data };
          return;
        }
      }
    },
    setMode: (mode: string) => call<unknown>("PUT", "/v1/me/mode", { mode }),
    listApprovals: () => call<{ approvals: Approval[] }>("GET", "/v1/approvals"),
    answerApproval: (id: string, decision: "allow" | "deny") =>
      call<{ accepted?: Accepted }>("POST", `/v1/approvals/${encodeURIComponent(id)}`, {
        decision,
        scope: "once",
      }),
    listSecrets: () =>
      call<{ secrets: { name: string; bindings: unknown }[] }>("GET", "/v1/secrets?level=user"),
    setSecret: (name: string, value: string, bindings: { plugins: string[]; hosts: string[] }) =>
      call<unknown>("PUT", `/v1/secrets/user/${encodeURIComponent(name)}`, { value, bindings }),
    deleteSecret: (name: string) =>
      call<unknown>("DELETE", `/v1/secrets/user/${encodeURIComponent(name)}`),
    getModelConfig: () => call<Record<string, unknown>>("GET", "/v1/me/models"),
    setModelConfig: (config: unknown) => call<unknown>("PUT", "/v1/me/models", config),
    listModels: (project: string) =>
      call<{ models: { id: string; alias?: string[] }[]; default?: string }>(
        "GET",
        `/v1/models?${new URLSearchParams({ project })}`,
      ),
    async list(path: string): Promise<FileEntry[]> {
      const res = await fetch(`${filePath(path)}?list`, { headers });
      return (await answer<{ entries: FileEntry[] }>(res)).entries;
    },
    async read(path: string): Promise<string> {
      const res = await fetch(filePath(path), { headers });
      if (!res.ok) await answer(res);
      return res.text();
    },
    async write(path: string, content: string): Promise<void> {
      const res = await fetch(filePath(path), {
        method: "PUT",
        headers: { authorization: headers.authorization },
        body: content,
      });
      if (!res.ok) await answer(res);
    },
  };
}
