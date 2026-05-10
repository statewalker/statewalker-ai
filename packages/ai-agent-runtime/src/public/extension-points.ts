import { newSlot } from "@statewalker/shared-slots";
import type {
  AgentMcpConnection,
  AgentSkillContribution,
  AgentToolContribution,
} from "./types.js";

/**
 * `agent:tools` — `ToolInput` (ToolSet | ToolFactory) contributions.
 * Each rebuild of `AgentRuntime` consumes the current snapshot.
 */
export const [provideAgentTool, observeAgentTools] =
  newSlot<AgentToolContribution>("agent:tools");

/** `agent:skills` — `SkillInfo` contributions. */
export const [provideAgentSkill, observeAgentSkills] =
  newSlot<AgentSkillContribution>("agent:skills");

/**
 * `agent:mcp-connections` — id-keyed MCP server configs. Manager
 * resolves duplicate ids last-wins at rebuild time.
 */
export const [provideAgentMcpConnection, observeAgentMcpConnections] =
  newSlot<AgentMcpConnection>("agent:mcp-connections");
