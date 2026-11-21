// The session API over RPC: webrun-rpc calls on a webrun-wire channel, here a WebSocket the
// deployment's Worker accepts at /v1/rpc. The access token goes in the first message.
import { sessionRpcClient, statusOf, webSocketPort } from "@statewalker/ai-sessions";
import type { Deployment } from "./deployment.js";
import { ApiError, type SessionClient } from "./session-client.js";

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
  const api = sessionRpcClient(webSocketPort(ws as never), token);
  const refusal = (e: unknown) => {
    throw new ApiError(statusOf(e), String((e as Error)?.message ?? e));
  };
  return {
    me: () => api.me().catch(refusal),
    startSession: (req) => api.startSession(req).catch(refusal),
    sendMessage: (id, req) => api.sendMessage(id, req).catch(refusal),
    listItems: (id) => api.listItems(id).catch(refusal),
    listSessions: () => api.listSessions().catch(refusal),
    profile: () => api.profile().catch(refusal),
    eraseUser: () => api.eraseUser().catch(refusal),
    listSecrets: (scope) => api.listSecrets(scope).catch(refusal),
    setSecret: (req) => api.setSecret(req).catch(refusal),
    deleteSecret: (req) => api.deleteSecret(req).catch(refusal),
    close: () => ws.close(1000, "done"),
  };
}
