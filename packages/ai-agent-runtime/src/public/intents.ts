import { defineCommand } from "@statewalker/shared-commands";

/**
 * Force the agent-runtime manager to rebuild the underlying
 * `AgentRuntime` (e.g. after a credentials edit). Default handler
 * lives in `AgentRuntimeManager`.
 */
export const RebuildAgentCommand = defineCommand<void, void>("agent:rebuild", () => {});
