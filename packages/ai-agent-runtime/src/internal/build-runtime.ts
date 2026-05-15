import type { ProviderV3 } from "@ai-sdk/provider";
import type { McpServerConfig } from "@statewalker/ai-agent/runtime";
import {
  AgentRuntime,
  type SkillInfo,
  type ToolInput,
} from "@statewalker/ai-agent/runtime";
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
  /** Slot-contributed tools. The built-in file tools come through
   * this slot via the `files/` fragment (Wave 5.1) — there is no
   * implicit tool installation in this builder. */
  tools: readonly ToolInput[];
  skills: readonly SkillInfo[];
  /** Already-deduped (last-wins by id). Empty record means no MCP. */
  mcpServers: Record<string, McpServerConfig>;
}

/**
 * Pure builder: takes resolved inputs and returns a built
 * `AgentRuntime`. Tools, skills, and MCP servers come from the
 * `agent:*` slots — the manager passes the snapshots in as
 * `input.tools` / `input.skills` / `input.mcpServers`. The builder
 * itself installs nothing implicitly.
 */
export async function buildRuntime(
  input: BuildRuntimeInput,
): Promise<AgentRuntime> {
  const systemPath = normalizeSystemPath(
    input.systemFolder ?? DEFAULT_SYSTEM_FOLDER,
  );
  const runtime = new AgentRuntime({ files: input.files }).setSystemPath(
    systemPath,
  );
  runtime.addModelProvider(input.provider);

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
