// Access: tokens and the issuer, the permission language, roles and role sources, capabilities,
// modes and permission rules, what the gate knows of approvals, and `auto` mode's risk classifier.

export { fromBase64, type Keypair, toBase64 } from "@statewalker/webrun-biscuit";
export {
  type ApprovalGrant,
  ApprovalRegistry,
  type ApprovalRequest,
  approvalId,
  type UserSessionState,
} from "./approvals.js";
export {
  type AutoDecision,
  type AutoStep,
  decideAuto,
  isBroadRule,
  isProtectedPath,
  withoutBroadAllows,
} from "./auto-mode.js";
export {
  type AgentSessionFacts,
  type AgentSessionGrant,
  type AuthorityOptions,
  attenuateForAgentSession,
  type FileAction,
  type FileRequest,
  type StoredRootKey,
  type SubAgentGrant,
  WorkspaceAuthority,
} from "./capabilities.js";
export {
  type AutoSettings,
  CLASSIFIER_SYSTEM,
  type ClassifierInput,
  classifierPrompt,
  classifierTranscript,
  DenialCounter,
  type PendingAction,
  parseAutoMode,
  parseClassifierAnswer,
  type TranscriptEntry,
  type TranscriptItem,
} from "./classifier.js";
export { type CodedError, codedError, codeOf, type ErrorCode, statusOf } from "./errors.js";
export {
  BUILT_IN_MODES,
  DEFAULT_MODE,
  decideMode,
  isMode,
  type ModeDecision,
  type ModeDefinition,
  type ModeRequest,
  matchRules,
  modeOf,
  PERMISSION_RULES_FILE,
  type PermissionRules,
  parseModes,
  parseRules,
  type ResolvedMode,
  type RuleLayer,
  type Verdict,
} from "./modes.js";
export {
  type AccessRequest,
  AREAS,
  decide,
  type Permission,
  parsePermissions,
  permissionsToDatalog,
  permits,
  type RoleGrant,
  type TargetKind,
  targetRegex,
} from "./permissions.js";
export {
  ACCESS_FILE,
  accessFilePath,
  accessOf,
  BUILT_IN_ROLES,
  chainRoleSources,
  DEFAULT_SYSTEM_FOLDER,
  fileRoleSource,
  type ProjectAccess,
  parseAccessFile,
  parseRolesFile,
  ROLES_FILE,
  type RoleEntries,
  type RoleSource,
  resolveRoles,
  rolesFilePath,
  type UserAccess,
  WORKSPACE_ROLES,
} from "./roles.js";
export {
  hashApiKey,
  isServiceAccount,
  newApiKey,
  serviceAccountUser,
} from "./service-accounts.js";
export { type SqlLike, SqlRoleSource } from "./sql-roles.js";
export { type AccessClaims, TokenIssuer, verifyAccessToken } from "./tokens.js";
export { settleAsk } from "./unattended.js";
