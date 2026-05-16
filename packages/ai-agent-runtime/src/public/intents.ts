import { Command, passthrough } from "@statewalker/shared-commands";

/**
 * Force the agent-runtime manager to rebuild the underlying
 * `AgentRuntime` (e.g. after a credentials edit). Default handler
 * lives in `AgentRuntimeManager`.
 */
export const RebuildAgentCommand = Command.silent("agent:rebuild")
  .input(passthrough<void>())
  .output(passthrough<void>())
  .build();
