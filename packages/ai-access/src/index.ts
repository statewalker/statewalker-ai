// Access: tokens and the issuer, roles and role sources, capabilities. Later tickets add the
// permission language, modes and permission rules, approvals and the risk classifier
// (statewalker/statewalker-root#111).

export { fromBase64, type Keypair, toBase64 } from "@statewalker/webrun-biscuit";
export { type StoredRootKey, WorkspaceAuthority } from "./capabilities.js";
export { type CodedError, codedError, codeOf, type ErrorCode, statusOf } from "./errors.js";
export {
  ACCESS_FILE,
  accessFilePath,
  BUILT_IN_ROLES,
  DEFAULT_SYSTEM_FOLDER,
  parseAccessFile,
} from "./roles.js";
export { type AccessClaims, TokenIssuer, verifyAccessToken } from "./tokens.js";
