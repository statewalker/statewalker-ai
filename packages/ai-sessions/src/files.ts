// The user's own file view over the session API (statewalker/statewalker-root#122): the same
// files-RPC protocol every holder speaks, here carried for a client outside the deployment.
// - RPC: a WebSocket (the Worker's /v1/files), msgpack frames through webrun-wire's multiplexer,
//   one port per connection serving the protocol's methods; the first call authenticates with the
//   access token, and every later call goes to the caller's User DO with it, checked each time.
// - REST: /v1/files/<path>: GET reads a file (streamed, block by block) or lists a folder (also
//   `?list`, `?recursive`), `?stats` answers its stats, PUT writes the body, DELETE removes, and
//   POST {op: "mkdir" | "copy" | "move", target?} does the rest. Each segment of the path is
//   percent-decoded once; the gate normalises what results.
import { codedError, statusOf } from "@statewalker/ai-access";
import { FILES_RPC_METHODS, type FilesRpcMethod, filesOverRpc } from "@statewalker/ai-environment";
import type { FilesApi } from "@statewalker/webrun-files";
import type { FilesRpc } from "@statewalker/webrun-files-rpc";
import { msgpackCodec } from "@statewalker/webrun-msgpack";
import { methodsClient, overPipe, serveMethods } from "@statewalker/webrun-rpc";
import { messageTargetOverWebSocket, type WebSocketLike } from "@statewalker/webrun-streams-ws";
import type { SessionApi } from "./api.js";
import { bearerOf, bodyOf } from "./rest.js";

const CHANNEL = "statewalker-ai/files/v1";
const METHODS = ["authenticate", ...FILES_RPC_METHODS] as const;
/** A write's last chunk may wait on a slow backend; the channel's close still ends a call. */
const TIMEOUT_MS = 15 * 60_000;

type FilesChannel = FilesRpc & { authenticate(token: string): Promise<true> };

/**
 * Serves the files-RPC protocol on a WebSocket, for the caller whose access token the first call
 * carries. Returns the teardown.
 */
export function serveFilesRpc(ws: WebSocketLike, open: (token: string) => SessionApi): () => void {
  const { target, signal } = messageTargetOverWebSocket(ws);
  const mux = overPipe(target, { codec: msgpackCodec, side: "responder", signal })((port) => {
    let api: SessionApi | undefined;
    const impl: Record<string, (...args: unknown[]) => Promise<unknown>> = {
      async authenticate(token) {
        if (api) throw codedError("EINVAL", "this channel is already authenticated");
        const opened = open(String(token ?? ""));
        await opened.me();
        api = opened;
        return true;
      },
    };
    for (const method of FILES_RPC_METHODS)
      impl[method] = async (...args) => {
        if (!api) throw codedError("EAUTH", "the first call carries the access token");
        return api.files(method, args);
      };
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

export interface FilesRpcConnection {
  /** The user's file view: a webrun-files-rpc client. */
  files: FilesApi;
  /** The protocol's calls themselves, for clients that drive streams by hand. */
  rpc: FilesRpc;
  close(): void;
}

/** The user's file view over a WebSocket to the deployment's /v1/files, with an access token. */
export async function filesRpcClient(
  ws: WebSocketLike,
  token: string,
  options: { blockSize?: number } = {},
): Promise<FilesRpcConnection> {
  const { target, signal } = messageTargetOverWebSocket(ws);
  const mux = await overPipe(target, { codec: msgpackCodec, side: "initiator", signal })();
  const port = await mux.openPort({ kind: "methods" });
  const channel = methodsClient<FilesChannel>(port, {
    channelName: CHANNEL,
    methods: METHODS,
    timeout: TIMEOUT_MS,
  });
  await channel.authenticate(token);
  const call = (method: FilesRpcMethod, args: unknown[]) =>
    (channel[method] as (...a: unknown[]) => Promise<unknown>)(...args);
  return {
    files: filesOverRpc(call, options),
    rpc: channel,
    close: () => {
      void mux.close();
      ws.close();
    },
  };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

/** The workspace path a /v1/files URL names: each segment decoded once. */
function pathOf(url: URL): string {
  const rest = url.pathname.slice("/v1/files".length).split("/").filter(Boolean);
  return `/${rest.map((s) => decodeURIComponent(s)).join("/")}`;
}

async function* requestBody(request: Request): AsyncIterable<Uint8Array> {
  if (!request.body) return;
  const reader = request.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    if (value?.length) yield value;
  }
}

/**
 * Answers a request to the REST routes of the user's file view (/v1/files/...), or returns
 * undefined when it is not one of them.
 */
export async function handleFilesRest(
  request: Request,
  open: (token: string) => SessionApi,
  options: { blockSize?: number } = {},
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname !== "/v1/files" && !url.pathname.startsWith("/v1/files/")) return undefined;
  try {
    const path = pathOf(url);
    const api = open(bearerOf(request));
    const files = filesOverRpc((method, args) => api.files(method, args), options);
    const q = url.searchParams;
    switch (request.method) {
      case "GET": {
        const stats = await files.stats(path);
        if (q.has("stats")) {
          if (!stats) throw codedError("ENOENT", `no such file or directory, '${path}'`);
          return json(stats);
        }
        if (!stats) throw codedError("ENOENT", `no such file or directory, '${path}'`);
        if (stats.kind === "directory" || q.has("list")) {
          const entries = [];
          for await (const e of files.list(path, { recursive: q.has("recursive") }))
            entries.push(e);
          return json({ entries });
        }
        const it = files.read(path)[Symbol.asyncIterator]();
        const body = new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              try {
                const r = await it.next();
                if (r.done) controller.close();
                else controller.enqueue(r.value);
              } catch (e) {
                controller.error(e);
              }
            },
            async cancel() {
              await it.return?.();
            },
          },
          { highWaterMark: 0 },
        );
        return new Response(body, {
          headers: {
            "content-type": "application/octet-stream",
            ...(stats.kind === "file" ? { "content-length": String(stats.size) } : {}),
          },
        });
      }
      case "PUT":
        await files.write(path, requestBody(request));
        return json({ written: true });
      case "DELETE":
        return json({ removed: await files.remove(path) });
      case "POST": {
        const { op, target } = await bodyOf(request);
        if (op === "mkdir") {
          await files.mkdir(path);
          return json({ done: true });
        }
        if ((op === "copy" || op === "move") && typeof target === "string")
          return json({ done: await files[op](path, target) });
        throw codedError("EINVAL", "op must be mkdir, or copy or move with a target");
      }
      default:
        throw codedError("EINVAL", `no ${request.method} on /v1/files`);
    }
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, statusOf(e));
  }
}
