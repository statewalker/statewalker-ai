// The harness's conformance suite: a runner for deployments on CellB (in-process), the scripted
// model, clients of the session API, and the threat-table check.

export { type WorkspaceBackend, workspaceBackend } from "./backends.js";
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
  type Item,
  login,
  makeUserUnreachable,
  type Profile,
  restClient,
  type SecretBinding,
  type SecretLevel,
  type SecretScope,
  type SecretView,
  type SessionClient,
  type SetSecretRequest,
  seed,
  seedProfiles,
  sendPastUser,
  setAccess,
  type Turn,
  type UserSession,
} from "./session-client.js";
export {
  checkThreatTable,
  collectTestTitles,
  parseThreatTable,
  type ThreatRow,
} from "./threat-table.js";
