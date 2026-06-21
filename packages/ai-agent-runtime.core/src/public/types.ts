import type { ProviderV3 } from "@ai-sdk/provider";
import type { McpServerConfig, SkillInfo, ToolInput } from "@statewalker/ai-agent.core/runtime";

/**
 * Pointer to the resolved provider+model. Written by the providers
 * fragment (Wave 4.2; an interim bootstrap stands in until then) and
 * read by the agent-runtime manager. Carries a concrete `ProviderV3`
 * factory so the manager doesn't have to look it up by id at rebuild
 * time.
 *
 * `kind: "remote"` covers @ai-sdk providers (OpenAI, Anthropic,
 * Google, OpenAI-compatible). `kind: "local"` covers a model loaded
 * into the in-app `ModelManager`. Both share the same `ProviderV3`
 * shape so AgentRuntime treats them uniformly.
 */
export interface ActiveModelValue {
  kind: "remote" | "local";
  providerId: string;
  modelId: string;
  createProvider: () => ProviderV3;
}

/**
 * Tool contribution for the `agent:tools` slot. Mirrors
 * `AgentRuntime.addTools(...)` accepted shapes.
 */
export type AgentToolContribution = ToolInput;

/**
 * Skill contribution for the `agent:skills` slot. Mirrors
 * `AgentRuntime.addSkills(...)`.
 */
export type AgentSkillContribution = SkillInfo;

/**
 * MCP connection contribution for the `agent:mcp-connections` slot.
 * Wired into `AgentRuntime.setMcpServers` at rebuild time. Each
 * contribution is keyed by `id` (server name); duplicate ids are
 * resolved last-wins by the manager.
 */
export interface AgentMcpConnection {
  id: string;
  config: McpServerConfig;
}
