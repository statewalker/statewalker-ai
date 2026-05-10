import { newIntent } from "@statewalker/shared-intents";

/**
 * Force the agent-runtime manager to rebuild the underlying
 * `AgentRuntime` (e.g. after a credentials edit). Default handler
 * lives in `AgentRuntimeManager`.
 */
export const [runRebuildAgent, handleRebuildAgent] = newIntent<void, void>(
  "agent:rebuild",
);
