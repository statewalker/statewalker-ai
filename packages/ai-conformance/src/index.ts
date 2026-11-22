// The harness's conformance suite: a runner for deployments on CellB (in-process), the scripted
// model, clients of the session API, and the threat-table check.

export { type WorkspaceBackend, workspaceBackend } from "./backends.js";
export {
  type DatabaseView,
  type DbClient,
  type DbRpcCalls,
  databaseStorage,
  type RpcDbClient,
  restDb,
  rpcDb,
  type ToolDbCall,
  toolDb,
} from "./db-client.js";
export { type Deployment, startDeployment } from "./deployment.js";
export { type FakeS3, fakeS3 } from "./fake-s3.js";
export { type FilesClient, restFiles, rpcFiles } from "./files-client.js";
export { type FakeModel, fakeModel, type ModelRequest } from "./model.js";
export { type FakeRest, fakeRest, type RestRequest } from "./rest-server.js";
export { type RpcSessionClient, rpcClient } from "./rpc-client.js";
export {
  type AccessFixture,
  type AgentSession,
  ApiError,
  type Approval,
  type ApprovalAnswer,
  advanceUserClock,
  type EventsPage,
  type EventsQuery,
  eventOf,
  flueStorage,
  type Item,
  type ItemsPage,
  type ItemsQuery,
  login,
  type McpMessage,
  type McpResponse,
  type MessageAccepted,
  type MessageRequest,
  type Metadata,
  type ModelsConfig,
  type ModelUsage,
  type ModelUsageRecord,
  type ModelView,
  makeUserUnreachable,
  modelUsage,
  openUserSessionAt,
  type Profile,
  renewToken,
  restClient,
  revokeUserEverywhere,
  type SecretBinding,
  type SecretLevel,
  type SecretScope,
  type SecretView,
  type ServiceAccount,
  type SessionClient,
  type SessionEvent,
  type SessionsQuery,
  type SetSecretRequest,
  type SseFrame,
  type StopReason,
  seed,
  seedProfiles,
  sendPastUser,
  serviceAccountToken,
  setAccess,
  sseFrames,
  TERMINAL_EVENTS,
  type Turn,
  type UserSession,
} from "./session-client.js";
export {
  checkThreatTable,
  collectTestTitles,
  parseThreatTable,
  type ThreatRow,
} from "./threat-table.js";
