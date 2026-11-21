// Access: tokens and the issuer, the permission language, roles and role sources, capabilities.
// Later tickets add modes and permission rules, approvals and the risk classifier
// (statewalker/statewalker-root#111).

export { fromBase64, type Keypair, toBase64 } from "@statewalker/webrun-biscuit";
export {
  type AgentSessionFacts,
  type AgentSessionGrant,
  attenuateForAgentSession,
  type FileAction,
  type FileRequest,
  type StoredRootKey,
  WorkspaceAuthority,
} from "./capabilities.js";
export { type CodedError, codedError, codeOf, type ErrorCode, statusOf } from "./errors.js";
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
export { type SqlLike, SqlRoleSource } from "./sql-roles.js";
export { type AccessClaims, TokenIssuer, verifyAccessToken } from "./tokens.js";
