// The harness's Worker: the session API over REST, and over RPC on a WebSocket at /v1/rpc
// (msgpack frames through webrun-wire, webrun-rpc methods; the access token in the first call); the user's own file view over REST
// (/v1/files/<path>) and over files-RPC on a WebSocket at /v1/files; a project's databases over REST
// (/v1/projects/<p>/databases) and over db-rpc on a WebSocket at /v1/databases; the OpenAI projection at
// each agent's base URL (/v1/projects/<p>/agents/<a>/); and the test-only routes a conformance
// run enables through vars (see wrangler.jsonc). Every session call goes to the User DO of the
// user the caller's access token names, which checks the token each time.
import { codedError } from "@statewalker/ai-access";
import { handleOpenAiRest } from "@statewalker/ai-openai-compat";
import {
  bearerOf,
  bodyOf,
  createSessionApi,
  errorResponse,
  handleDatabasesRest,
  handleFilesRest,
  handleSessionRest,
  ndjsonResponse,
  serveDatabasesRpc,
  serveFilesRpc,
  serveSessionRpc,
} from "@statewalker/ai-sessions";
import { handleUhpRest } from "@statewalker/ai-uhp";
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
export { Database } from "./database-do.js";
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
      admitRequest: async (t, kind) => (await user()).admitRequest(t, kind),
      openUserSession: async (t) => (await user()).openUserSession(t),
      startAgentSession: async (t, req) => (await user()).startAgentSession(t, req),
      ownAgentSession: async (t, id) => (await user()).ownAgentSession(t, id),
      listAgentSessions: async (t) => (await user()).listAgentSessions(t),
      updateAgentSession: async (t, id, m) => (await user()).updateAgentSession(t, id, m),
      archiveAgentSession: async (t, id) => (await user()).archiveAgentSession(t, id),
      subtree: async (t, id) => (await user()).subtree(t, id),
      forkAgentSession: async (t, from, req) => (await user()).forkAgentSession(t, from, req),
      deleteAgentSession: async (t, id) => (await user()).deleteAgentSession(t, id),
      profile: async (t) => (await user()).profile(t),
      eraseUser: async (t) => (await user()).eraseUser(t),
      setMode: async (t, mode) => (await user()).setMode(t, mode),
      listApprovals: async (t) => (await user()).listApprovals(t),
      answerApproval: async (t, id, answer) => (await user()).answerApproval(t, id, answer),
      files: async (t, method, args) => (await user()).files(t, method, args),
      listDatabases: async (t, project) => (await user()).listDatabases(t, project),
      databaseCall: async (t, call) => (await user()).databaseCall(t, call),
      listSecrets: async (t, scope) => (await user()).listSecrets(t, scope),
      setSecret: async (t, req) => (await user()).setSecret(t, req),
      deleteSecret: async (t, req) => (await user()).deleteSecret(t, req),
      revokeAgentSession: async (t, id) => (await user()).revokeAgentSession(t, id),
      revokeUserSession: async (t) => (await user()).revokeUserSession(t),
      listServiceAccounts: async (t) => (await user()).listServiceAccounts(t),
      createServiceAccount: async (t, name) => (await user()).createServiceAccount(t, name),
      deleteServiceAccount: async (t, name) => (await user()).deleteServiceAccount(t, name),
      listModels: async (t, query) => (await user()).listModels(t, query),
      listAgents: async (t, query) => (await user()).listAgents(t, query),
      getModelConfig: async (t) => (await user()).getModelConfig(t),
      setModelConfig: async (t, config) => (await user()).setModelConfig(t, config),
      holdStream: async (t) => (await user()).holdStream(t),
      releaseStream: async (t, id) => (await user()).releaseStream(t, id),
      memory: async (t, call) => (await user()).memory(t, call),
      exportProfile: async (t) => (await user()).exportProfile(t),
      eraseProfile: async (t) => (await user()).eraseProfile(t),
      effectiveLimits: async (t, q) => (await user()).effectiveLimits(t, q),
      usage: async (t, q) => (await user()).usage(t, q),
      manageLimits: async (t, call) => (await user()).manageLimits(t, call),
      usageRecords: async (t, q) => (await user()).usageRecords(t, q),
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
        answer: (approval, answer) => agent.answer(approval, answer),
        mcp: (message) => agent.mcp(message),
        limits: () => agent.limits(),
        usage: () => agent.usage(),
        ownLimits: (limits) => agent.ownLimits(limits),
        rewind: (req) => agent.rewind(req),
        setHead: (turn) => agent.setHead(turn),
        edit: (turnId, req) => agent.edit(turnId, req),
        regenerate: (turnId, req) => agent.regenerate(turnId, req),
        branches: () => agent.branches(),
        eraseBranch: (turnId) => agent.eraseBranch(turnId),
        topics: (query) => agent.topics(query),
        exportPath: (atTurn) => agent.exportPath(atTurn),
        importHistory: (history) => agent.importHistory(history),
      };
    },
  });
}

/**
 * The token issuer's routes (statewalker/statewalker-root#78, #127): a service account's API key
 * for an access token (`POST /v1/token {key}`), and a valid access token for a fresh one
 * (`POST /v1/token/renew`, the token as bearer). People get their first token from an identity
 * provider, which is outside the harness.
 */
async function tokenRoutes(request: Request, env: Env, path: string) {
  if (request.method !== "POST") return undefined;
  if (path === "/v1/token") {
    const body = await bodyOf(request);
    if (typeof body.key !== "string" || !body.key) throw codedError("EINVAL", "key is required");
    return json(await issuerOf(env).exchangeApiKey(body.key));
  }
  if (path === "/v1/token/renew") return json(await issuerOf(env).renew(bearerOf(request)));
  return undefined;
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
  if (collection === "users" && id && sub === "clock") {
    // Moves the user's clock forward (approvals expire by it), so a scenario sees a day pass.
    return json({ offset: await userOf(env, id).advanceClock(Number(body.advance_ms)) });
  }
  if (collection === "users" && id && sub === "revoke") {
    // The operator revokes a user everywhere, at the issuer.
    await issuerOf(env).revokeUser(id);
    return json({ revoked: id });
  }
  if (collection === "workspaces" && id && sub === "clock") {
    // Moves the workspace's limits clock forward, so a scenario places a request in a window.
    if (!workspacesOf(env).includes(id))
      throw codedError("EINVAL", `this deployment does not serve '${id}'`);
    return json({ offset: await workspaceOf(env, id).advanceClock(Number(body.advance_ms)) });
  }
  if (collection === "workspaces" && id && sub === "user-session") {
    // Hands an access token straight to one workspace's DO, whichever workspace it names: only a
    // token for that workspace opens a user session there. The capability is not returned.
    if (!workspacesOf(env).includes(id))
      throw codedError("EINVAL", `this deployment does not serve '${id}'`);
    await workspaceOf(env, id).userCapability(String(body.token ?? ""));
    return json({ opened: true });
  }
  if (collection === "workspaces" && id && sub === "delete-project") {
    if (!workspacesOf(env).includes(id))
      throw codedError("EINVAL", `this deployment does not serve '${id}'`);
    await workspaceOf(env, id).deleteProject(String(body.project ?? ""));
    return json({ deleted: true });
  }
  if (collection === "workspaces" && id && sub === "model-usage") {
    // The workspace's model budget, every request recorded (usage reports are #179's).
    if (!workspacesOf(env).includes(id))
      throw codedError("EINVAL", `this deployment does not serve '${id}'`);
    return json({ usage: await workspaceOf(env, id).modelUsage() });
  }
  if (collection === "sessions" && id && sub === "flue-storage") {
    // The rows of Flue's tables in the session's DO; `forget` first drops its in-memory Flue
    // session, as a fresh DO instance has none.
    return json({ tables: await agentOf(env, id).flueStorage(body.forget === true) });
  }
  if (collection === "workspaces" && id && sub === "database-storage") {
    // Every database of the workspace and its size: the storage meter's input (#179).
    if (!workspacesOf(env).includes(id))
      throw codedError("EINVAL", `this deployment does not serve '${id}'`);
    return json({ databases: await workspaceOf(env, id).databaseStorage() });
  }
  if (collection === "sessions" && id && sub === "tool-db") {
    // One database call as a plugin tool of the session makes it (until tool scripts run).
    return json(await agentOf(env, id).toolDatabase(body as never));
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

/** Whether two keys are the same, compared in constant time (over their SHA-256 digests). */
async function sameKey(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const digest = async (v: string) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(v)));
  const x = await digest(a);
  const y = await digest(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/**
 * The operator's export of usage records across workspaces (statewalker/statewalker-root#181):
 * `GET /v1/usage/records?since&workspace` with the operator token (OPERATOR_KEY) as bearer, as
 * NDJSON, every workspace the deployment serves (or the one named) in turn. Usage under users' own
 * keys is theirs alone and is not among them. Any other bearer is a session API caller.
 */
async function operatorRoutes(request: Request, env: Env, path: string) {
  if (path !== "/v1/usage/records" || request.method !== "GET" || !env.OPERATOR_KEY)
    return undefined;
  if (!(await sameKey(bearerOf(request), env.OPERATOR_KEY))) return undefined;
  const url = new URL(request.url);
  const since = Number(url.searchParams.get("since")) || 0;
  const named = url.searchParams.get("workspace");
  if (named && !workspacesOf(env).includes(named))
    throw codedError("ENOENT", `this deployment does not serve '${named}'`);
  const workspaces = named ? [named] : workspacesOf(env);
  // The workspaces one after the other: `next` is the seq within the current one, and 0 starts
  // the next workspace.
  let index = 0;
  const pageOf = async (after: number): Promise<{ records: unknown[]; next?: number }> => {
    for (;;) {
      const name = workspaces[index] as string;
      const page = (await workspaceOf(env, name).operatorUsageExport({
        since,
        after,
      })) as unknown as { records: unknown[]; next?: number };
      if (page.next !== undefined) return page;
      index += 1;
      if (index >= workspaces.length) return { records: page.records };
      if (page.records.length) return { records: page.records, next: 0 };
      after = 0;
    }
  };
  return ndjsonResponse(await pageOf(0), pageOf);
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

/** A project's databases over db-rpc: a WebSocket this Worker serves until it closes. */
function databasesChannel(env: Env): Response {
  const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
  server.accept();
  const stop = serveDatabasesRpc(server as never, (token) => sessionApi(env, token));
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
      if (path === "/v1/databases" && request.headers.get("upgrade")?.toLowerCase() === "websocket")
        return databasesChannel(env);
      const databases = await handleDatabasesRest(request, (token) => sessionApi(env, token));
      if (databases) return databases;
      const files = await handleFilesRest(request, (token) => sessionApi(env, token), {
        blockSize: blockSizeOf(env),
      });
      if (files) return files;
      const token = await tokenRoutes(request, env, path);
      if (token) return token;
      const operator = await operatorRoutes(request, env, path);
      if (operator) return operator;
      const dev = await devRoutes(request, env, path);
      if (dev) return dev;
      // The OpenAI projection, at each agent's base URL (statewalker/statewalker-root#138).
      const openai = await handleOpenAiRest(request, (token) => sessionApi(env, token), {
        keepAliveMs: Number(env.SSE_KEEPALIVE_MS) || undefined,
      });
      if (openai) return openai;
      // The UHP projection, under /uhp (statewalker/statewalker-root#139).
      const uhp = await handleUhpRest(request, (token) => sessionApi(env, token), {
        keepAliveMs: Number(env.SSE_KEEPALIVE_MS) || undefined,
      });
      if (uhp) return uhp;
      const rest = await handleSessionRest(request, (token) => sessionApi(env, token), {
        keepAliveMs: Number(env.SSE_KEEPALIVE_MS) || undefined,
      });
      if (rest) return rest;
      return json({ error: "ENOENT: no such route" }, 404);
    } catch (e) {
      return errorResponse(e);
    }
  },
};
