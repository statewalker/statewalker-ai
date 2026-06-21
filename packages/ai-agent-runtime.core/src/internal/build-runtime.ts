import type { ProviderV3 } from "@ai-sdk/provider";
import type { McpServerConfig } from "@statewalker/ai-agent.core/runtime";
import { AgentRuntime, type SkillInfo, type ToolInput } from "@statewalker/ai-agent.core/runtime";
import { createFileTools } from "@statewalker/ai-agent.core/tools";
import type { FilesApi } from "@statewalker/webrun-files";

const DEFAULT_SYSTEM_FOLDER = "/.settings";

function normalizeSystemPath(folder: string): string {
  const trimmed = folder.replace(/^\/+|\/+$/g, "");
  return `/${trimmed}`;
}

export interface BuildRuntimeInput {
  files: FilesApi;
  systemFolder?: string;
  provider: ProviderV3;
  /** Extra slot-contributed tools (`agent:tools`). The built-in file
   * tools are installed by this builder directly (see `build`), so this
   * list carries only additional contributions. */
  tools: readonly ToolInput[];
  skills: readonly SkillInfo[];
  /** Already-deduped (last-wins by id). Empty record means no MCP. */
  mcpServers: Record<string, McpServerConfig>;
}

/**
 * Pure builder: takes resolved inputs and returns a built
 * `AgentRuntime`. The built-in file tools are installed here as a
 * `ToolFactory` (the runtime calls it with its filtered tools-view, so
 * the tools never see hidden system paths). Extra slot-contributed
 * tools, skills, and MCP servers arrive via `input.tools` /
 * `input.skills` / `input.mcpServers`.
 */
export async function buildRuntime(input: BuildRuntimeInput): Promise<AgentRuntime> {
  const systemPath = normalizeSystemPath(input.systemFolder ?? DEFAULT_SYSTEM_FOLDER);
  const runtime = new AgentRuntime({ files: input.files }).setSystemPath(systemPath);
  runtime.addModelProvider(input.provider);

  // Built-in file tools: the factory receives the runtime's filtered
  // tools-view (`ctx.files`), not the raw workspace files.
  runtime.addTools((ctx) => createFileTools(ctx.files));

  if (input.tools.length > 0) {
    runtime.addTools(...input.tools);
  }
  if (input.skills.length > 0) {
    runtime.addSkills(...input.skills);
  }
  if (Object.keys(input.mcpServers).length > 0) {
    runtime.setMcpServers(input.mcpServers);
  }

  await runtime.build();
  return runtime;
}
