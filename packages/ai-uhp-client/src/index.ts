// Remote agent sessions (statewalker/statewalker-root#109, #144): agent sessions whose core is an
// external harness behind a UHP server (Unified Harness Protocol 2026-10-19). They work on copies
// of files; their changes return through the capability.
export { type CollectedInputs, collectInputs, inputMatches, packInput } from "./inputs.js";
export { itemsOf } from "./items.js";
export {
  answerInput,
  artifactsOf,
  foldUhpServers,
  inputRequestOf,
  isTerminal,
  isUhpId,
  parseRemoteAgentId,
  parseUhpServers,
  projectPathOf,
  remoteAgentId,
  remoteAgents,
  UHP_PLUGIN,
  UHP_VERSION,
  type UhpArtifact,
  type UhpInputRequest,
  type UhpItem,
  type UhpResponse,
  type UhpServer,
  type UhpStatus,
  uhpError,
} from "./protocol.js";
export {
  type ChangeSetFile,
  RemoteCore,
  type RemoteOptions,
  type RemotePort,
  type UhpAnswer,
  type UhpCall,
} from "./remote-core.js";
