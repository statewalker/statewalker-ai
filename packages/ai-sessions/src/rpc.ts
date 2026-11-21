// RPC onto the session API's methods: webrun-rpc request/answer calls on one channel (a
// MessageTarget: a WebSocket through ./web-socket-port.ts, a MessagePort, a webrun-wire stream).
// The access token goes in the first message; every later call on the channel is made with it.
import { codedError } from "@statewalker/ai-access";
import { callPort, listenPort, type MessageTarget } from "@statewalker/webrun-rpc";
import type { SessionApi, UserSessionView } from "./api.js";

const CHANNEL = "statewalker-ai/session-api/v1";
const METHODS = [
  "me",
  "startSession",
  "sendMessage",
  "listItems",
  "listSessions",
  "profile",
  "eraseUser",
  "listSecrets",
  "setSecret",
  "deleteSecret",
] as const;
type Method = (typeof METHODS)[number];
type Call = { method: "authenticate" | Method; args: unknown[] };

/** A turn can run for minutes; the channel's close signal ends a call sooner. */
const TIMEOUT_MS = 15 * 60_000;

/**
 * Serves the session API on a channel: the first call authenticates with the access token, the
 * rest go to the methods of the API opened with it. Returns the teardown.
 */
export function serveSessionRpc(
  port: MessageTarget,
  open: (token: string) => SessionApi,
): () => void {
  // Set once the first message's token is accepted. Each call still goes to the caller's User DO
  // with the token, so it is checked again every time (expiry included).
  let api: SessionApi | undefined;
  return listenPort<Call>(
    port,
    async ({ method, args }) => {
      if (method === "authenticate") {
        if (api) throw codedError("EINVAL", "this channel is already authenticated");
        const opened = open(String(args?.[0] ?? ""));
        const me = await opened.me();
        api = opened;
        return me;
      }
      if (!api) throw codedError("EAUTH", "the first message carries the access token");
      if (!(METHODS as readonly string[]).includes(method))
        throw codedError("EINVAL", `no method '${String(method)}'`);
      return (api[method] as (...a: unknown[]) => Promise<unknown>)(...(args ?? []));
    },
    { channelName: CHANNEL },
  );
}

/**
 * The session API over a channel. The access token is sent first; every call waits for it, and
 * fails as it failed (EAUTH) when the token is refused.
 */
export function sessionRpcClient(port: MessageTarget, token: string): SessionApi {
  const call = <T>(method: Call["method"], args: unknown[]) =>
    callPort<T, Call>(port, { method, args }, { channelName: CHANNEL, timeout: TIMEOUT_MS });
  const authenticated = call<UserSessionView>("authenticate", [token]);
  authenticated.catch(() => {});
  const after =
    <T>(method: Method) =>
    (...args: unknown[]) =>
      authenticated.then(() => call<T>(method, args));
  return {
    me: after("me"),
    startSession: after("startSession"),
    sendMessage: after("sendMessage"),
    listItems: after("listItems"),
    listSessions: after("listSessions"),
    profile: after("profile"),
    eraseUser: after("eraseUser"),
    listSecrets: after("listSecrets"),
    setSecret: after("setSecret"),
    deleteSecret: after("deleteSecret"),
  } as SessionApi;
}
