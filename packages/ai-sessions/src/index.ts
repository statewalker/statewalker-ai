// Sessions: user and agent sessions, turns, items, and the session API as methods with REST and
// RPC routers onto them; turns, the event log and its SSE stream (statewalker/statewalker-root#125).
// Summaries, compaction and the model context of a turn (statewalker/statewalker-root#131).

export { codeOf, statusOf } from "@statewalker/ai-access";
export {
  type ActionCall,
  AgentSessionCore,
  type RecordApprovals,
  type RunAction,
  type RunTurn,
  type Steer,
  type TurnOutcome,
  type TurnRun,
} from "./agent-session.js";
export {
  type AgentMessage,
  type AgentPort,
  type AgentRun,
  type AgentSessionConfig,
  type AgentSessionView,
  type ApprovalAnswer,
  type ApprovalRequest,
  type ApprovalView,
  type CreatedServiceAccount,
  createSessionApi,
  type DatabaseCall,
  type DatabaseView,
  type DeleteSecretRequest,
  type Delivery,
  type EventsPage,
  type EventsQuery,
  type GateDecisionInput,
  type Item,
  type ItemInput,
  type ItemsPage,
  type ItemsQuery,
  type LimitWarningView,
  type McpMessage,
  type McpResponse,
  type MessageAccepted,
  type Metadata,
  type ModelSubstitution,
  type ModelsConfig,
  type ModelsQuery,
  type ModelUsage,
  type ModelView,
  mcpMessage,
  metadataOf,
  type PinnedDefinitions,
  type ProfileView,
  type SecretBinding,
  type SecretLevel,
  type SecretScope,
  type SecretView,
  type SendMessageRequest,
  type ServiceAccountView,
  type SessionApi,
  type SessionApiPorts,
  type SessionEvent,
  type SessionStatus,
  type SessionsQuery,
  type SetSecretRequest,
  type StartSessionRequest,
  type StopLimit,
  type StopReason,
  type StoredAction,
  type SubAgentRequest,
  TERMINAL_TURN_STATUSES,
  type TurnStatus,
  type TurnView,
  type UserPort,
  type UserSessionView,
} from "./api.js";
export {
  createTokenEstimator,
  type TokenEstimator,
  type TokenEstimatorOptions,
} from "./context/estimate.js";
export {
  type CompactionOptions,
  type ContextEntry,
  ContextShaper,
  compactionOptions,
  DEFAULT_COMPACTION,
  parseCompaction,
  type TailSize,
} from "./context/shaper.js";
export {
  type Complete,
  createModelSummarizer,
  type ModelSummarizerOptions,
  parseSummary,
  renderItems,
  renderSummaries,
  SUMMARIZER_PROMPT_START,
  type Summarizer,
  type SummarizerInput,
  type Summary,
  type SummaryOutput,
  type SummarySection,
} from "./context/summarizer.js";
export {
  createTrimPolicy,
  type TrimOptions,
  type TrimPolicy,
  type TrimStrategy,
  trimToolResult,
} from "./context/trim.js";
export {
  type DatabasesRpcConnection,
  databasesRpcClient,
  handleDatabasesRest,
  serveDatabasesRpc,
} from "./databases.js";
export {
  type FilesRpcConnection,
  filesRpcClient,
  handleFilesRest,
  serveFilesRpc,
} from "./files.js";
export { bearerOf, bodyOf, errorResponse, handleSessionRest } from "./rest.js";
export { type SessionRpcConnection, serveSessionRpc, sessionRpcClient } from "./rpc.js";
export type { SqlLike } from "./sql.js";
export { sessionOfTurn } from "./turns.js";
export {
  DEFAULT_MODE,
  UserSessions,
  type UserSessionsOptions,
  type WorkspaceGrants,
} from "./user-sessions.js";
