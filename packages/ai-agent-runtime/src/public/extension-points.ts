import { defineSlot } from "@statewalker/shared-slots";
import type {
  AgentMcpConnection,
  AgentSkillContribution,
  AgentToolContribution,
} from "./types.js";

/**
 * `agent:tools` — `ToolInput` (ToolSet | ToolFactory) contributions.
 * Each rebuild of `AgentRuntime` consumes the current snapshot.
 */
export const agentToolsSlot = defineSlot<AgentToolContribution>("agent:tools");

/** `agent:skills` — `SkillInfo` contributions. */
export const agentSkillsSlot = defineSlot<AgentSkillContribution>("agent:skills");

/**
 * `agent:mcp-connections` — id-keyed MCP server configs. Manager
 * resolves duplicate ids last-wins at rebuild time.
 */
export const agentMcpConnectionsSlot = defineSlot<AgentMcpConnection>(
  "agent:mcp-connections",
);
