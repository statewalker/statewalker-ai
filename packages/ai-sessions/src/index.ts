// Sessions: user and agent sessions, turns, items, and the session API as methods with REST and
// RPC routers onto them. Later tickets add summaries and the event log
// (statewalker/statewalker-root#111).

export { codeOf, statusOf } from "@statewalker/ai-access";
export {
  type ActionCall,
  AgentSessionCore,
  type RunAction,
  type RunTurn,
} from "./agent-session.js";
export {
  type AgentPort,
  type AgentSessionConfig,
  type AgentSessionView,
  type AgentTurn,
  type ApprovalAnswer,
  type ApprovalRequest,
  type ApprovalView,
  createSessionApi,
  type DeleteSecretRequest,
  type Item,
  type ItemInput,
  type ProfileView,
  type SecretBinding,
  type SecretLevel,
  type SecretScope,
  type SecretView,
  type SendMessageRequest,
  type SessionApi,
  type SessionApiPorts,
  type SetSecretRequest,
  type StartSessionRequest,
  type StoredAction,
  type TurnView,
  type UserPort,
  type UserSessionView,
} from "./api.js";
export {
  type FilesRpcConnection,
  filesRpcClient,
  handleFilesRest,
  serveFilesRpc,
} from "./files.js";
export { bearerOf, bodyOf, handleSessionRest } from "./rest.js";
export { serveSessionRpc, sessionRpcClient } from "./rpc.js";
export type { SqlLike } from "./sql.js";
export {
  DEFAULT_MODE,
  UserSessions,
  type UserSessionsOptions,
  type WorkspaceGrants,
} from "./user-sessions.js";
export { type WebSocketLike, webSocketPort } from "./web-socket-port.js";
