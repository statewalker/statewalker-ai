import { tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../../src/state/tool-registry.js";

function makeTool(desc: string) {
  return tool({
    description: desc,
    inputSchema: z.object({}),
    execute: async () => desc,
  });
}

describe("ToolRegistry", () => {
  it("register adds a tool to toToolSet()", () => {
    const reg = new ToolRegistry();
    reg.register("my_tool", makeTool("test"));

    const set = reg.toToolSet();
    expect(set).toHaveProperty("my_tool");
    expect(reg.size).toBe(1);
  });

  it("unregister removes the tool", () => {
    const reg = new ToolRegistry();
    const unsub = reg.register("my_tool", makeTool("test"));
    unsub();

    const set = reg.toToolSet();
    expect(set).not.toHaveProperty("my_tool");
    expect(reg.size).toBe(0);
  });

  it("toToolSet returns snapshot of current tools", () => {
    const reg = new ToolRegistry();
    reg.register("a", makeTool("A"));
    const unsub = reg.register("b", makeTool("B"));
    reg.register("c", makeTool("C"));
    unsub();

    const set = reg.toToolSet();
    expect(Object.keys(set)).toEqual(["a", "c"]);
  });

  it("notifies on register", () => {
    const reg = new ToolRegistry();
    const listener = vi.fn();
    reg.onUpdate(listener);

    reg.register("x", makeTool("X"));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("notifies on unregister", () => {
    const reg = new ToolRegistry();
    const unsub = reg.register("x", makeTool("X"));

    const listener = vi.fn();
    reg.onUpdate(listener);

    unsub();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
