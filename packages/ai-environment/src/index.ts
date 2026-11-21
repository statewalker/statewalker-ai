// The environment: the workspace store, the gated file view and the file protocol to it. Later
// tickets add databases, search, executors, tools, the model gateway and secrets
// (statewalker/statewalker-root#111).
export {
  type ApprovalAnswerOfGate,
  ApprovalPending,
  answerFileCall,
  type FileCall,
  filesOverCalls,
  isApprovalAnswer,
} from "./file-calls.js";
export { type FileOp, type GatedFilesOptions, gatedFiles, inSystemFolder } from "./gated-files.js";
export { nameOf, normalise, parentOf } from "./paths.js";
export {
  mountProfiles,
  PROFILES_ROOT,
  type ProfilesBackend,
  profileFiles,
  profilePath,
  rootedFiles,
} from "./profile-files.js";
export {
  checkBinding,
  checkSecretName,
  deploymentSecrets,
  type GatewayResult,
  gatewayFetch,
  type OutgoingRequest,
  type Resolution,
  type ResolvedSecret,
  redactSecrets,
  resolveSecrets,
  SECRET_LEVELS,
  type SecretBinding,
  type SecretInfo,
  type SecretLevel,
  type SecretLookup,
  SecretStore,
  type StoredLevel,
  sessionSecrets,
} from "./secrets.js";
export { SqlFiles, type SqlLike } from "./sql-files.js";
