import { BaseClass } from "@repo/shared/models";
import { tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { bridgeMcpTools } from "../../src/mcp/bridge-mcp-tools.js";
import { ToolRegistry } from "../../src/state/tool-registry.js";

function makeTool(desc: string) {
  return tool({
    description: desc,
    inputSchema: z.object({}),
    execute: async () => desc,
  });
}

/** Minimal McpClientManager stub with onUpdate + tools. */
class FakeMcp extends BaseClass {
  private _tools: Record<string, ReturnType<typeof makeTool>> = {};

  get tools() {
    return this._tools;
  }

  setTools(tools: Record<string, ReturnType<typeof makeTool>>) {
    this._tools = tools;
    this.notify();
  }
}

describe("bridgeMcpTools", () => {
  it("registers MCP tools in the registry on initial sync", () => {
    const mcp = new FakeMcp();
    mcp.setTools({ mcp_a: makeTool("A"), mcp_b: makeTool("B") });

    const registry = new ToolRegistry();
    bridgeMcpTools(mcp as any, registry);

    const set = registry.toToolSet();
    expect(set).toHaveProperty("mcp_a");
    expect(set).toHaveProperty("mcp_b");
  });

  it("re-syncs when MCP notifies (server connect)", () => {
    const mcp = new FakeMcp();
    const registry = new ToolRegistry();
    bridgeMcpTools(mcp as any, registry);

    expect(registry.size).toBe(0);

    mcp.setTools({ mcp_new: makeTool("new") });
    expect(registry.toToolSet()).toHaveProperty("mcp_new");
  });

  it("removes old tools on re-sync", () => {
    const mcp = new FakeMcp();
    mcp.setTools({ mcp_old: makeTool("old") });

    const registry = new ToolRegistry();
    bridgeMcpTools(mcp as any, registry);
    expect(registry.toToolSet()).toHaveProperty("mcp_old");

    mcp.setTools({ mcp_new: makeTool("new") });
    expect(registry.toToolSet()).not.toHaveProperty("mcp_old");
    expect(registry.toToolSet()).toHaveProperty("mcp_new");
  });

  it("MCP tools coexist with static tools", () => {
    const mcp = new FakeMcp();
    mcp.setTools({ mcp_tool: makeTool("mcp") });

    const registry = new ToolRegistry();
    registry.register("local_tool", makeTool("local"));
    bridgeMcpTools(mcp as any, registry);

    const set = registry.toToolSet();
    expect(set).toHaveProperty("local_tool");
    expect(set).toHaveProperty("mcp_tool");
  });

  it("cleanup stops listening and unregisters MCP tools", () => {
    const mcp = new FakeMcp();
    mcp.setTools({ mcp_tool: makeTool("mcp") });

    const registry = new ToolRegistry();
    const cleanup = bridgeMcpTools(mcp as any, registry);
    expect(registry.toToolSet()).toHaveProperty("mcp_tool");

    cleanup();
    expect(registry.toToolSet()).not.toHaveProperty("mcp_tool");

    // Further MCP changes don't affect registry
    mcp.setTools({ mcp_after: makeTool("after") });
    expect(registry.toToolSet()).not.toHaveProperty("mcp_after");
  });
});
