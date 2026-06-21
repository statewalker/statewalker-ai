import { defineSlot } from "@statewalker/shared-slots";
import type { AgentMcpConnection, AgentSkillContribution, AgentToolContribution } from "./types.js";

/**
 * `agent:tools` — `ToolInput` (ToolSet | ToolFactory) contributions.
 * Each rebuild of `AgentRuntime` consumes the current snapshot.
 */
export const agentToolsSlot = defineSlot<AgentToolContribution>("agent:tools");

/** `agent:skills` — `SkillInfo` contributions. */
export const agentSkillsSlot = defineSlot<AgentSkillContribution>("agent:skills");

/**
 * `agent:system-prompt` — plain text blocks appended to the agent's base system
 * prompt (in contribution order) at each rebuild. Lets a fragment steer the agent
 * (e.g. "prefer the wiki tools for project questions") without owning the prompt.
 */
export const agentSystemPromptSlot = defineSlot<string>("agent:system-prompt");

/**
 * `agent:mcp-connections` — id-keyed MCP server configs. Manager
 * resolves duplicate ids last-wins at rebuild time.
 */
export const agentMcpConnectionsSlot = defineSlot<AgentMcpConnection>("agent:mcp-connections");
