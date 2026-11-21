// The environment: the workspace store, the gated file view and the file protocol to it. Later
// tickets add databases, search, executors, tools, the model gateway and secrets
// (statewalker/statewalker-root#111).

export {
  FILES_RPC_METHODS,
  type FilesRpcCall,
  type FilesRpcEndpoint,
  FilesRpcHost,
  type FilesRpcMethod,
  filesOverRpc,
  filesRpcEndpoint,
  gatedFilesRpc,
} from "./files-rpc.js";
export {
  DEFAULT_BLOCK_SIZE,
  type FileAction,
  type GatedFilesOptions,
  gatedFiles,
  type IgnoreMatcher,
  inSystemFolder,
  stillAllowed,
} from "./gated-files.js";
export { IGNORE_FILE, ignoreRules } from "./ignore-rules.js";
export { nameOf, normalise, parentOf } from "./paths.js";
export {
  mountProfiles,
  PROFILES_ROOT,
  type ProfilesBackend,
  profileFiles,
  profilePath,
  rootedFiles,
} from "./profile-files.js";
