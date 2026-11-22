// The UHP projection of the session API (statewalker/statewalker-root#139, decided in #108,
// amended by #157 and #159): UHP class Core plus `input_requests`, pinned to UHP `2026-10-19`, so
// UHP clients drive harness agents. Each agent the user may start is a harness
// `<project>/<plugin>/<agent>`, a UHP session is an agent session and a response is a turn.
export { toUhpError, UhpError, uhpError } from "./errors.js";
export {
  findHarness,
  HARNESS_BASE,
  HARNESS_PREFIX,
  type HarnessRef,
  harnessId,
  harnessName,
  harnessView,
  parseHarness,
} from "./harnesses.js";
export {
  type CreatedTask,
  createTask,
  INPUT_REQUEST_PREFIX,
  inputRequestId,
  RESPONSE_PREFIX,
  responseId,
  responseOf,
  type UhpApi,
} from "./responses.js";
export {
  DISCOVERY,
  handleUhpRest,
  UHP_BASE_PATH,
  UHP_SPEC_COMMIT,
  UHP_VERSION,
  type UhpOptions,
  uhpFetch,
} from "./routes.js";
export { taskEvents } from "./stream.js";
