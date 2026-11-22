// The user's own file view as a client sees it: a FilesApi over the session API, by REST (routes
// under /v1/files) or by RPC (files-RPC on the WebSocket at /v1/files). Scenarios are written
// against `FilesClient`, so the same scenario runs over both.
import { filesRpcClient } from "@statewalker/ai-sessions";
import type { FileInfo, FileStats, FilesApi, ReadOptions } from "@statewalker/webrun-files";
import type { Deployment } from "./deployment.js";
import { ApiError } from "./session-client.js";

export interface FilesClient extends FilesApi {
  close(): void;
}

/**
 * The URL of a path. A URL cannot carry dot segments (even percent-encoded, URL parsing resolves
 * them), so they are resolved here as any HTTP client would; the server resolves what is left.
 */
function filesUrl(path: string): string {
  const out: string[] = [];
  for (const s of path.split("/")) {
    if (!s || s === ".") continue;
    if (s === "..") out.pop();
    else out.push(encodeURIComponent(s));
  }
  return `/v1/files/${out.join("/")}`;
}

async function refusal(res: Response): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  throw new ApiError(res.status, String(body.error ?? res.statusText));
}

async function collect(content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>) {
  const parts: Uint8Array[] = [];
  for await (const p of content) parts.push(p);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The user's file view over REST. Paths are sent segment by segment, percent-encoded. */
export function restFiles(deployment: Deployment, token: string): FilesClient {
  const send = (path: string, init: RequestInit = {}, query = "") =>
    deployment.fetch(`${filesUrl(path)}${query}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });
  const op = async (path: string, body: unknown) => {
    const res = await send(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) await refusal(res);
    return ((await res.json()) as { done: boolean }).done;
  };
  return {
    async *read(path: string, options?: ReadOptions) {
      const res = await send(path);
      if (res.status === 404) return;
      if (!res.ok) await refusal(res);
      if (res.headers.get("content-type")?.includes("json")) return;
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      let at = 0;
      const start = options?.start ?? 0;
      const end = options?.length === undefined ? Infinity : start + options.length;
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (e) {
          // Over HTTP a body the server ends with an error (a block refused midway) only breaks
          // the connection, without the reason: asking again answers it, as the response's status.
          const again = await send(path);
          if (!again.ok) await refusal(again);
          await again.body?.cancel();
          throw e;
        }
        const { value, done } = chunk;
        if (done) return;
        const from = Math.max(0, start - at);
        const to = Math.min(value.length, end - at);
        at += value.length;
        if (to > from) yield value.subarray(from, to);
        if (at >= end) return;
      }
    },
    async *list(path: string, options?: { recursive?: boolean }) {
      const res = await send(path, {}, `?list${options?.recursive ? "&recursive" : ""}`);
      if (res.status === 404) return;
      if (!res.ok) await refusal(res);
      yield* ((await res.json()) as { entries: FileInfo[] }).entries;
    },
    async stats(path: string) {
      const res = await send(path, {}, "?stats");
      if (res.status === 404) return undefined;
      if (!res.ok) await refusal(res);
      return (await res.json()) as FileStats;
    },
    async exists(path: string) {
      return (await this.stats(path)) !== undefined;
    },
    async write(path, content) {
      const res = await send(path, { method: "PUT", body: await collect(content) });
      if (!res.ok) await refusal(res);
    },
    async mkdir(path: string) {
      await op(path, { op: "mkdir" });
    },
    async remove(path: string) {
      const res = await send(path, { method: "DELETE" });
      if (!res.ok) await refusal(res);
      return ((await res.json()) as { removed: boolean }).removed;
    },
    copy: (source: string, target: string) => op(source, { op: "copy", target }),
    move: (source: string, target: string) => op(source, { op: "move", target }),
    close: () => {},
  };
}

interface ClientSocket {
  accept(): void;
  close(code?: number, reason?: string): void;
}

/** The user's file view over files-RPC on a WebSocket to the deployment's /v1/files. */
export async function rpcFiles(deployment: Deployment, token: string): Promise<FilesClient> {
  const res = await deployment.fetch("/v1/files", { headers: { upgrade: "websocket" } });
  const ws = (res as Response & { webSocket?: ClientSocket | null }).webSocket;
  if (res.status !== 101 || !ws) throw new ApiError(res.status, "the deployment refused files RPC");
  ws.accept();
  const connection = await filesRpcClient(ws as never, token);
  return Object.assign(connection.files, { close: connection.close });
}
