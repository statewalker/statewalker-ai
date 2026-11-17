// Sessions: user and agent sessions, turns, items, and the session API as methods with REST and
// RPC routers onto them. Later tickets add summaries and the event log
// (statewalker/statewalker-root#111).

export { codeOf, statusOf } from "@statewalker/ai-access";
export { AgentSessionCore, type RunTurn } from "./agent-session.js";
export {
  type AgentPort,
  type AgentSessionConfig,
  type AgentSessionView,
  createSessionApi,
  type Item,
  type ItemInput,
  type SendMessageRequest,
  type SessionApi,
  type SessionApiPorts,
  type StartSessionRequest,
  type TurnView,
  type UserSessionView,
  type WorkspacePort,
} from "./api.js";
export { bearerOf, bodyOf, handleSessionRest } from "./rest.js";
export { serveSessionRpc, sessionRpcClient } from "./rpc.js";
export type { SqlLike } from "./sql.js";
export { type WebSocketLike, webSocketPort } from "./web-socket-port.js";
export { WorkspaceSessions, type WorkspaceSessionsOptions } from "./workspace-sessions.js";
