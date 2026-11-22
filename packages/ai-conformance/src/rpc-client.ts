// The session API over RPC: webrun-rpc methods over msgpack frames on a WebSocket the
// deployment's Worker accepts at /v1/rpc. The access token goes in the first call.
import { sessionRpcClient, statusOf } from "@statewalker/ai-sessions";
import type { Deployment } from "./deployment.js";
import { ApiError, type SessionClient, TERMINAL_EVENTS, type Turn } from "./session-client.js";

interface ClientSocket {
  accept(): void;
  close(code?: number, reason?: string): void;
}

export interface RpcSessionClient extends SessionClient {
  close(): void;
}

/** Opens a WebSocket to the deployment and runs the session API's RPC client over it. */
export async function rpcClient(deployment: Deployment, token: string): Promise<RpcSessionClient> {
  const res = await deployment.fetch("/v1/rpc", { headers: { upgrade: "websocket" } });
  const ws = (res as Response & { webSocket?: ClientSocket | null }).webSocket;
  if (res.status !== 101 || !ws) throw new ApiError(res.status, "the deployment refused RPC");
  ws.accept();
  const connection = await sessionRpcClient(ws as never, token);
  const api = connection.api;
  const refusal = (e: unknown) => {
    throw new ApiError(statusOf(e), String((e as Error)?.message ?? e));
  };
  const client: RpcSessionClient = {
    me: () => api.me().catch(refusal),
    startSession: (req) => api.startSession(req).catch(refusal),
    getSession: (id) => api.getSession(id).catch(refusal),
    updateSession: (id, req) => api.updateSession(id, req).catch(refusal),
    archiveSession: (id) => api.archiveSession(id).catch(refusal),
    deleteSession: (id) => api.deleteSession(id).catch(refusal),
    listSessions: (q) => api.listSessions(q).catch(refusal),
    postMessage: (id, req) => api.sendMessage(id, req).catch(refusal),
    sendMessage: async (id, req) => client.waitTurn(await client.postMessage(id, req)),
    async waitTurn(accepted) {
      // Cursor reads of the event log, each waiting for the next event.
      let since = accepted.offset;
      for (;;) {
        const page = await api
          .readEvents(accepted.session_id, { since, wait: 10_000 })
          .catch(refusal);
        for (const event of page.events)
          if (TERMINAL_EVENTS.includes(event.type) && event.turn === accepted.turn_id)
            return event.data as Turn;
        since = page.offset;
      }
    },
    getTurn: (id) => api.getTurn(id).catch(refusal),
    cancelTurn: (id) => api.cancelTurn(id).catch(refusal),
    listItems: (id, q) => api.listItems(id, q).catch(refusal),
    getItem: (id, itemId) => api.getItem(id, itemId).catch(refusal),
    readEvents: (id, q) => api.readEvents(id, q).catch(refusal),
    profile: () => api.profile().catch(refusal),
    eraseUser: () => api.eraseUser().catch(refusal),
    setMode: (req) => api.setMode(req).catch(refusal) as never,
    listApprovals: () => api.listApprovals().catch(refusal) as never,
    answerApproval: (id, answer) => api.answerApproval(id, answer).catch(refusal) as never,
    listSecrets: (scope) => api.listSecrets(scope).catch(refusal),
    setSecret: (req) => api.setSecret(req).catch(refusal),
    deleteSecret: (req) => api.deleteSecret(req).catch(refusal),
    revokeSession: (id) => api.revokeSession(id).catch(refusal),
    revokeUserSession: () => api.revokeUserSession().catch(refusal),
    listServiceAccounts: () => api.listServiceAccounts().catch(refusal),
    createServiceAccount: (req) => api.createServiceAccount(req).catch(refusal),
    deleteServiceAccount: (name) => api.deleteServiceAccount(name).catch(refusal),
    listModels: (q) => api.listModels(q).catch(refusal) as never,
    getModelConfig: () => api.getModelConfig().catch(refusal) as never,
    setModelConfig: (config) => api.setModelConfig(config as never).catch(refusal) as never,
    close: () => connection.close(),
  };
  return client;
}
