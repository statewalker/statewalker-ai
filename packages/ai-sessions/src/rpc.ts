// RPC onto the session API's methods, on a WebSocket (the Worker's /v1/rpc): msgpack frames
// through webrun-wire's multiplexer, one port per connection serving the API's methods
// (webrun-rpc's serveMethods). The first call authenticates with the access token; every later
// call on the connection is made with it, and goes to the caller's User DO, which checks it again.
import { codedError } from "@statewalker/ai-access";
import { msgpackCodec } from "@statewalker/webrun-msgpack";
import { methodsClient, overPipe, serveMethods } from "@statewalker/webrun-rpc";
import { messageTargetOverWebSocket, type WebSocketLike } from "@statewalker/webrun-streams-ws";
import type { SessionApi, UserSessionView } from "./api.js";

const CHANNEL = "statewalker-ai/session-api/v1";
const METHODS = [
  "me",
  "startSession",
  "getSession",
  "updateSession",
  "archiveSession",
  "deleteSession",
  "sendMessage",
  "getTurn",
  "cancelTurn",
  "listItems",
  "getItem",
  "readEvents",
  "mcp",
  "listSessions",
  "profile",
  "eraseUser",
  "setMode",
  "listApprovals",
  "answerApproval",
  "listSecrets",
  "setSecret",
  "deleteSecret",
  "revokeSession",
  "revokeUserSession",
  "listServiceAccounts",
  "createServiceAccount",
  "deleteServiceAccount",
  "listModels",
  "getModelConfig",
  "setModelConfig",
  "listDatabases",
  "rewind",
  "setHead",
  "editTurn",
  "regenerateTurn",
  "listBranches",
  "eraseBranch",
  "forkSession",
] as const;
type Method = (typeof METHODS)[number];
type Channel = Pick<SessionApi, Method> & { authenticate(token: string): Promise<UserSessionView> };
const SERVED = ["authenticate", ...METHODS] as const;

/** A turn can run for minutes and an event read waits; the connection's close ends a call sooner. */
const TIMEOUT_MS = 15 * 60_000;

/**
 * Serves the session API on a WebSocket, for the caller whose access token the first call
 * carries. Returns the teardown.
 */
export function serveSessionRpc(
  ws: WebSocketLike,
  open: (token: string) => SessionApi,
): () => void {
  const { target, signal } = messageTargetOverWebSocket(ws);
  const mux = overPipe(target, { codec: msgpackCodec, side: "responder", signal })((port) => {
    // Set once the first call's token is accepted. Each call still goes to the caller's User DO
    // with the token, so it is checked again every time (expiry included).
    let api: SessionApi | undefined;
    const impl: Record<string, (...args: unknown[]) => Promise<unknown>> = {
      async authenticate(token) {
        if (api) throw codedError("EINVAL", "this channel is already authenticated");
        const opened = open(String(token ?? ""));
        const me = await opened.me();
        api = opened;
        return me;
      },
    };
    for (const method of METHODS)
      impl[method] = async (...args) => {
        if (!api) throw codedError("EAUTH", "the first call carries the access token");
        return (api[method] as (...a: unknown[]) => Promise<unknown>)(...args);
      };
    serveMethods(port, impl, { channelName: CHANNEL, methods: SERVED, timeout: TIMEOUT_MS });
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

export interface SessionRpcConnection {
  api: SessionApi;
  close(): void;
}

/**
 * The session API over a WebSocket to the deployment's /v1/rpc. The access token is sent first;
 * every call waits for it, and fails as it failed (EAUTH) when the token is refused.
 */
export async function sessionRpcClient(
  ws: WebSocketLike,
  token: string,
): Promise<SessionRpcConnection> {
  const { target, signal } = messageTargetOverWebSocket(ws);
  const mux = await overPipe(target, { codec: msgpackCodec, side: "initiator", signal })();
  const port = await mux.openPort({ kind: "methods" });
  const channel = methodsClient<Channel>(port, {
    channelName: CHANNEL,
    methods: SERVED,
    timeout: TIMEOUT_MS,
  });
  const authenticated = channel.authenticate(token);
  authenticated.catch(() => {});
  const api = Object.fromEntries(
    METHODS.map((m) => [
      m,
      (...args: unknown[]) =>
        authenticated.then(() => (channel[m] as (...a: unknown[]) => Promise<unknown>)(...args)),
    ]),
  ) as unknown as SessionApi;
  return {
    api,
    close: () => {
      void mux.close();
      ws.close();
    },
  };
}
