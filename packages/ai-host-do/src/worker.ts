// The harness's Worker: the session API over REST, and over RPC on a WebSocket at /v1/rpc
// (msgpack frames through webrun-wire, webrun-rpc methods; the access token in the first call); the user's own file view over REST
// (/v1/files/<path>) and over files-RPC on a WebSocket at /v1/files; and the test-only routes a conformance
// run enables through vars (see wrangler.jsonc). Every session call goes to the User DO of the
// user the caller's access token names, which checks the token each time.
import { codedError, statusOf } from "@statewalker/ai-access";
import {
  bearerOf,
  bodyOf,
  createSessionApi,
  handleFilesRest,
  handleSessionRest,
  serveFilesRpc,
  serveSessionRpc,
} from "@statewalker/ai-sessions";
import {
  agentOf,
  blockSizeOf,
  defaultWorkspace,
  type Env,
  issuerOf,
  profilesOf,
  userOf,
  verifyToken,
  workspaceOf,
  workspacesOf,
} from "./env.js";

export { AgentSession } from "./agent-session-do.js";
export { Issuer } from "./issuer-do.js";
export { Profiles } from "./profiles-do.js";
export { User } from "./user-do.js";
export { Workspace } from "./workspace-do.js";

const json = (value: unknown, status = 200) => Response.json(value, { status });

function sessionApi(env: Env, token: string) {
  // The token is verified here only to find its user's User DO, which verifies it again.
  let stub: Promise<ReturnType<typeof userOf>> | undefined;
  const user = () => {
    stub ??= verifyToken(env, token).then((claims) => userOf(env, claims.user));
    return stub;
  };
  return createSessionApi(token, {
    user: {
      openUserSession: async (t) => (await user()).openUserSession(t),
      startAgentSession: async (t, req) => (await user()).startAgentSession(t, req),
      ownAgentSession: async (t, id) => (await user()).ownAgentSession(t, id),
      listAgentSessions: async (t) => (await user()).listAgentSessions(t),
      updateAgentSession: async (t, id, m) => (await user()).updateAgentSession(t, id, m),
      archiveAgentSession: async (t, id) => (await user()).archiveAgentSession(t, id),
      deleteAgentSession: async (t, id) => (await user()).deleteAgentSession(t, id),
      profile: async (t) => (await user()).profile(t),
      eraseUser: async (t) => (await user()).eraseUser(t),
      files: async (t, method, args) => (await user()).files(t, method, args),
      listSecrets: async (t, scope) => (await user()).listSecrets(t, scope),
      setSecret: async (t, req) => (await user()).setSecret(t, req),
      deleteSecret: async (t, req) => (await user()).deleteSecret(t, req),
    },
    agent: (id) => {
      const agent = agentOf(env, id);
      return {
        start: (config) => agent.start(config),
        send: (message) => agent.send(message),
        turn: (turnId) => agent.turn(turnId),
        cancel: (turnId) => agent.cancel(turnId),
        items: (query) => agent.items(query),
        item: (itemId) => agent.item(itemId),
        events: (query) => agent.events(query),
        status: () => agent.status(),
        archive: () => agent.archive(),
        purge: () => agent.purge(),
      };
    },
  });
}

async function devRoutes(request: Request, env: Env, path: string) {
  if (path === "/v1/login" && request.method === "POST" && env.DEV_LOGIN === "true") {
    // Test-only: stands in for an identity provider, which would prove who the user is.
    const body = await bodyOf(request);
    if (typeof body.user !== "string" || !body.user) throw codedError("EINVAL", "user is required");
    const ttlMs = typeof body.ttlMs === "number" ? body.ttlMs : undefined;
    const workspace = typeof body.workspace === "string" ? body.workspace : defaultWorkspace(env);
    return json(await issuerOf(env).issue(body.user, workspace, ttlMs));
  }
  if (!path.startsWith("/admin/") || request.method !== "POST" || !env.ADMIN_KEY) return undefined;
  if (bearerOf(request) !== env.ADMIN_KEY) throw codedError("EAUTH", "admin only");
  const body = await bodyOf(request);
  if (path === "/admin/seed") {
    const workspace = typeof body.workspace === "string" ? body.workspace : defaultWorkspace(env);
    if (!workspacesOf(env).includes(workspace))
      throw codedError("EINVAL", `this deployment does not serve '${workspace}'`);
    const files = body.files as Record<string, string>;
    return json({ written: await workspaceOf(env, workspace).seed(files) });
  }
  if (path === "/admin/access") {
    const workspace = typeof body.workspace === "string" ? body.workspace : defaultWorkspace(env);
    if (!workspacesOf(env).includes(workspace))
      throw codedError("EINVAL", `this deployment does not serve '${workspace}'`);
    await workspaceOf(env, workspace).setAccess(body as never);
    return json({ ok: true });
  }
  if (path === "/admin/profiles") {
    const files = body.files as Record<string, string>;
    return json({ written: await profilesOf(env).seed(files) });
  }
  const [, , collection, id, sub] = path.split("/").map(decodeURIComponent);
  if (collection === "users" && id && sub === "unreachable") {
    await userOf(env, id).makeUnreachable();
    return json({ unreachable: id });
  }
  if (collection === "sessions" && id && sub === "messages") {
    // Past the User DO, straight to the agent session: its turn's file calls go to the gate.
    if (typeof body.content !== "string") throw codedError("EINVAL", "content is required");
    const agent = agentOf(env, id);
    const { turn_id } = await agent.send({ content: body.content, delivery: "next", ignored: [] });
    return json(await agent.waitTurn(turn_id));
  }
  return undefined;
}

/** The session API's RPC channel: a WebSocket this Worker accepts and serves until it closes. */
function rpcChannel(request: Request, env: Env): Response {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
    return json({ error: "EINVAL: /v1/rpc takes a WebSocket" }, 426);
  const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
  server.accept();
  const stop = serveSessionRpc(server as never, (token) => sessionApi(env, token));
  server.addEventListener("close", () => stop());
  return new Response(null, { status: 101, webSocket: client });
}

/** The user's own file view over files-RPC: a WebSocket this Worker serves until it closes. */
function filesChannel(env: Env): Response {
  const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
  server.accept();
  const stop = serveFilesRpc(server as never, (token) => sessionApi(env, token));
  server.addEventListener("close", () => stop());
  return new Response(null, { status: 101, webSocket: client });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      if (path === "/v1/rpc") return rpcChannel(request, env);
      if (path === "/v1/files" && request.headers.get("upgrade")?.toLowerCase() === "websocket")
        return filesChannel(env);
      const files = await handleFilesRest(request, (token) => sessionApi(env, token), {
        blockSize: blockSizeOf(env),
      });
      if (files) return files;
      const dev = await devRoutes(request, env, path);
      if (dev) return dev;
      const rest = await handleSessionRest(request, (token) => sessionApi(env, token), {
        keepAliveMs: Number(env.SSE_KEEPALIVE_MS) || undefined,
      });
      if (rest) return rest;
      return json({ error: "ENOENT: no such route" }, 404);
    } catch (e) {
      return json({ error: String((e as Error)?.message ?? e) }, statusOf(e));
    }
  },
};
