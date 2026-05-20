/**
 * The legacy three-Dialog `makeModelsConfigSpec()` factory has been
 * retired in favour of two tab-body specs (one per Settings tab).
 * Use `makeConnectionsTabSpec()` and `makeLocalModelsTabSpec()`
 * from the sibling modules. See ADR 0011.
 */
export { makeConnectionsTabInitialState, makeConnectionsTabSpec } from "./connections-tab-spec.js";
export { makeLocalModelsTabInitialState, makeLocalModelsTabSpec } from "./local-models-tab-spec.js";
