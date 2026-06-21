import type { ProviderV3 } from "@ai-sdk/provider";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { buildRuntime } from "./build-runtime.js";

// The runtime builder owns the built-in file tools (Step 0a — reverts the
// Wave 4.1 move into the `files` fragment). A built runtime must expose them
// even when no `agent:tools` contribution is supplied.
describe("buildRuntime", () => {
  it("installs the built-in file tools without any slot contribution", async () => {
    const runtime = await buildRuntime({
      files: new MemFilesApi(),
      provider: {} as ProviderV3,
      tools: [],
      skills: [],
      mcpServers: {},
    });

    const toolNames = Object.keys(runtime.resolvedTools);
    expect(toolNames).toContain("read_file");
    expect(toolNames).toContain("write_file");
    expect(toolNames).toContain("list_files");
    expect(toolNames).toContain("edit_file");
  });

  it("keeps slot-contributed tools alongside the built-ins", async () => {
    const runtime = await buildRuntime({
      files: new MemFilesApi(),
      provider: {} as ProviderV3,
      tools: [{ custom_tool: {} as never }],
      skills: [],
      mcpServers: {},
    });

    const toolNames = Object.keys(runtime.resolvedTools);
    expect(toolNames).toContain("read_file");
    expect(toolNames).toContain("custom_tool");
  });
});
