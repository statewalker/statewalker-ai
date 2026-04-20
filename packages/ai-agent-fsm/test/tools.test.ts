import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { executeTool, executeToolCalls } from "../src/tools.js";
import type { AgentTool, ToolCallInfo, ToolContext } from "../src/types.js";

const echoTool: AgentTool = {
  name: "echo",
  description: "Echo input",
  parameters: z.object({ text: z.string() }),
  execute: async (params: unknown, _ctx: ToolContext) => {
    const { text } = params as { text: string };
    return text;
  },
};

const failTool: AgentTool = {
  name: "fail",
  description: "Always fails",
  parameters: z.object({}),
  execute: async (_params: unknown, _ctx: ToolContext) => {
    throw new Error("Something went wrong");
  },
};

// ── executeTool ─────────────────────────────────────────────

describe("executeTool", () => {
  it("returns the tool output on success", async () => {
    const call: ToolCallInfo = {
      toolCallId: "tc1",
      toolName: "echo",
      args: { text: "hello" },
    };
    const result = await executeTool(echoTool, call, AbortSignal.timeout(5000));
    expect(result).toEqual({
      toolCallId: "tc1",
      toolName: "echo",
      output: "hello",
    });
  });

  it("returns an isError result when execute throws", async () => {
    const call: ToolCallInfo = {
      toolCallId: "tc2",
      toolName: "fail",
      args: {},
    };
    const result = await executeTool(failTool, call, AbortSignal.timeout(5000));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Something went wrong");
    expect(result.toolCallId).toBe("tc2");
  });

  it("passes the correct toolCallId and signal to the tool", async () => {
    const signal = AbortSignal.timeout(5000);
    const spy = vi.fn(async (_params: unknown, _ctx: ToolContext) => {
      return "ok";
    });
    const spyTool: AgentTool = {
      name: "spy",
      description: "Spy tool",
      parameters: z.object({}),
      execute: spy,
    };
    const call: ToolCallInfo = {
      toolCallId: "tc-spy",
      toolName: "spy",
      args: {},
    };
    await executeTool(spyTool, call, signal);

    expect(spy).toHaveBeenCalledOnce();
    const [, ctx] = spy.mock.calls[0]!;
    expect((ctx as { toolCallId: string }).toolCallId).toBe("tc-spy");
    expect((ctx as { signal: AbortSignal }).signal).toBe(signal);
  });
});

// ── executeToolCalls ────────────────────────────────────────

describe("executeToolCalls", () => {
  it("executes multiple tools in parallel", async () => {
    const calls: ToolCallInfo[] = [
      { toolCallId: "a", toolName: "echo", args: { text: "one" } },
      { toolCallId: "b", toolName: "echo", args: { text: "two" } },
    ];
    const results = await executeToolCalls(
      [echoTool],
      calls,
      AbortSignal.timeout(5000),
    );
    expect(results).toHaveLength(2);
    expect(results[0]?.output).toBe("one");
    expect(results[1]?.output).toBe("two");
  });

  it("returns an error result for an unknown tool name", async () => {
    const calls: ToolCallInfo[] = [
      { toolCallId: "x", toolName: "nonexistent", args: {} },
    ];
    const results = await executeToolCalls(
      [echoTool],
      calls,
      AbortSignal.timeout(5000),
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.isError).toBe(true);
    expect(results[0]?.output).toContain('Unknown tool "nonexistent"');
  });

  it("all results have matching toolCallIds", async () => {
    const calls: ToolCallInfo[] = [
      { toolCallId: "id-1", toolName: "echo", args: { text: "a" } },
      { toolCallId: "id-2", toolName: "echo", args: { text: "b" } },
    ];
    const results = await executeToolCalls(
      [echoTool],
      calls,
      AbortSignal.timeout(5000),
    );
    expect(results[0]?.toolCallId).toBe("id-1");
    expect(results[1]?.toolCallId).toBe("id-2");
  });

  it("handles a mix of success and failure", async () => {
    const calls: ToolCallInfo[] = [
      { toolCallId: "ok", toolName: "echo", args: { text: "works" } },
      { toolCallId: "err", toolName: "fail", args: {} },
      { toolCallId: "missing", toolName: "unknown", args: {} },
    ];
    const results = await executeToolCalls(
      [echoTool, failTool],
      calls,
      AbortSignal.timeout(5000),
    );
    expect(results).toHaveLength(3);

    // Success
    expect(results[0]?.output).toBe("works");
    expect(results[0]?.isError).toBeUndefined();

    // Execute threw
    expect(results[1]?.isError).toBe(true);
    expect(results[1]?.output).toContain("Something went wrong");

    // Unknown tool
    expect(results[2]?.isError).toBe(true);
    expect(results[2]?.output).toContain("Unknown tool");
  });
});
