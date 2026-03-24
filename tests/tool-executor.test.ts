import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/events/agent-events.js";
import type {
  AgentTool,
  ToolContext,
  ToolOutput,
} from "../src/tools/agent-tool.js";
import { ToolError } from "../src/tools/agent-tool.js";
import { executeToolCalls, mergeBatch } from "../src/tools/tool-executor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTool(name: string, result: string, delay = 0): AgentTool {
  return {
    name,
    label: name,
    description: `Tool ${name}`,
    parametersSchema: { type: "object", properties: {} },
    async execute(_params: unknown, _ctx: ToolContext): Promise<ToolOutput> {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      return { text: result };
    },
  };
}

function makeFailingTool(name: string, errorMsg: string): AgentTool {
  return {
    name,
    label: name,
    description: `Failing tool ${name}`,
    parametersSchema: { type: "object", properties: {} },
    async execute(): Promise<ToolOutput> {
      throw new ToolError(errorMsg, "failed");
    },
  };
}

function makeStreamingTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: `Streaming tool ${name}`,
    parametersSchema: { type: "object", properties: {} },
    async execute(_params: unknown, ctx: ToolContext): Promise<ToolOutput> {
      ctx.onProgress?.("Step 1...");
      await new Promise((r) => setTimeout(r, 5));
      ctx.onUpdate?.({ text: "partial result" });
      await new Promise((r) => setTimeout(r, 5));
      ctx.onProgress?.("Step 2...");
      return { text: "final result" };
    },
  };
}

async function collectEvents(
  gen: AsyncGenerator<AgentEvent, unknown>,
): Promise<{ events: AgentEvent[]; result: unknown }> {
  const events: AgentEvent[] = [];
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  return { events, result: next.value };
}

// ---------------------------------------------------------------------------
// mergeBatch
// ---------------------------------------------------------------------------

describe("mergeBatch", () => {
  it("merges empty list", async () => {
    const gen = mergeBatch<number, string, undefined>([]);
    const { done, value } = await gen.next();
    expect(done).toBe(true);
    expect(value).toEqual([]);
  });

  it("merges single sync generator", async () => {
    async function* single() {
      yield 1;
      yield 2;
      return "done";
    }
    const events: number[] = [];
    const gen = mergeBatch([single()]);
    let next = await gen.next();
    while (!next.done) {
      events.push(next.value);
      next = await gen.next();
    }
    expect(events).toEqual([1, 2]);
    expect(next.value).toEqual(["done"]);
  });

  it("interleaves events from concurrent generators", async () => {
    async function* a() {
      yield "a1";
      await new Promise((r) => setTimeout(r, 10));
      yield "a2";
      return "A";
    }
    async function* b() {
      yield "b1";
      yield "b2";
      return "B";
    }
    const events: string[] = [];
    const gen = mergeBatch([a(), b()]);
    let next = await gen.next();
    while (!next.done) {
      events.push(next.value);
      next = await gen.next();
    }
    expect(events).toContain("a1");
    expect(events).toContain("a2");
    expect(events).toContain("b1");
    expect(events).toContain("b2");
    expect(events).toHaveLength(4);
    expect(next.value).toEqual(["A", "B"]);
  });

  it("supports sync iterables", async () => {
    function* syncGen() {
      yield 10;
      yield 20;
      return "sync";
    }
    const events: number[] = [];
    const gen = mergeBatch([syncGen()]);
    let next = await gen.next();
    while (!next.done) {
      events.push(next.value);
      next = await gen.next();
    }
    expect(events).toEqual([10, 20]);
    expect(next.value).toEqual(["sync"]);
  });
});

// ---------------------------------------------------------------------------
// executeToolCalls — sequential
// ---------------------------------------------------------------------------

describe("executeToolCalls — sequential", () => {
  it("executes single tool and yields events", async () => {
    const tools = [makeTool("echo", "hello")];
    const calls = [{ id: "tc-1", name: "echo", args: {} }];

    const { events, result } = await collectEvents(
      executeToolCalls(tools, calls, AbortSignal.timeout(5000), {
        type: "sequential",
      }),
    );

    const types = events.map((e) => e.props.type);
    expect(types).toContain("agent:tool-call");
    expect(types).toContain("agent:tool-result");

    const toolResult = result as { toolResults: unknown[] };
    expect(toolResult.toolResults).toHaveLength(1);
  });

  it("handles missing tool gracefully", async () => {
    const tools = [makeTool("echo", "hello")];
    const calls = [{ id: "tc-1", name: "nonexistent", args: {} }];

    const { events, result } = await collectEvents(
      executeToolCalls(tools, calls, AbortSignal.timeout(5000), {
        type: "sequential",
      }),
    );

    const resultEvent = events.find(
      (e) => e.props.type === "agent:tool-result",
    );
    expect(resultEvent?.props).toHaveProperty("isError", "true");

    const toolResult = result as { toolResults: Array<{ isError: boolean }> };
    expect(toolResult.toolResults[0]?.isError).toBe(true);
  });

  it("handles tool error gracefully", async () => {
    const tools = [makeFailingTool("fail", "something went wrong")];
    const calls = [{ id: "tc-1", name: "fail", args: {} }];

    const { events, result } = await collectEvents(
      executeToolCalls(tools, calls, AbortSignal.timeout(5000), {
        type: "sequential",
      }),
    );

    const resultEvent = events.find(
      (e) => e.props.type === "agent:tool-result",
    );
    expect(resultEvent?.blocks[0]?.content).toContain("something went wrong");

    const toolResult = result as { toolResults: Array<{ isError: boolean }> };
    expect(toolResult.toolResults[0]?.isError).toBe(true);
  });

  it("executes multiple tools in order", async () => {
    const tools = [makeTool("a", "result-a"), makeTool("b", "result-b")];
    const calls = [
      { id: "tc-1", name: "a", args: {} },
      { id: "tc-2", name: "b", args: {} },
    ];

    const { events, result } = await collectEvents(
      executeToolCalls(tools, calls, AbortSignal.timeout(5000), {
        type: "sequential",
      }),
    );

    const toolCallEvents = events.filter(
      (e) => e.props.type === "agent:tool-call",
    );
    expect(toolCallEvents).toHaveLength(2);

    const toolResult = result as {
      toolResults: Array<{ content: string }>;
    };
    expect(toolResult.toolResults).toHaveLength(2);
    expect(toolResult.toolResults[0]?.content).toBe("result-a");
    expect(toolResult.toolResults[1]?.content).toBe("result-b");
  });
});

// ---------------------------------------------------------------------------
// executeToolCalls — parallel
// ---------------------------------------------------------------------------

describe("executeToolCalls — parallel", () => {
  it("executes tools concurrently", async () => {
    const tools = [
      makeTool("slow", "slow-result", 20),
      makeTool("fast", "fast-result", 0),
    ];
    const calls = [
      { id: "tc-1", name: "slow", args: {} },
      { id: "tc-2", name: "fast", args: {} },
    ];

    const { result } = await collectEvents(
      executeToolCalls(tools, calls, AbortSignal.timeout(5000), {
        type: "parallel",
      }),
    );

    const toolResult = result as { toolResults: Array<{ content: string }> };
    expect(toolResult.toolResults).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// executeToolCalls — batched
// ---------------------------------------------------------------------------

describe("executeToolCalls — batched", () => {
  it("executes tools in batches of given size", async () => {
    const tools = [makeTool("a", "a"), makeTool("b", "b"), makeTool("c", "c")];
    const calls = [
      { id: "tc-1", name: "a", args: {} },
      { id: "tc-2", name: "b", args: {} },
      { id: "tc-3", name: "c", args: {} },
    ];

    const { result } = await collectEvents(
      executeToolCalls(tools, calls, AbortSignal.timeout(5000), {
        type: "batched",
        size: 2,
      }),
    );

    const toolResult = result as { toolResults: Array<{ content: string }> };
    expect(toolResult.toolResults).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Streaming events from tools
// ---------------------------------------------------------------------------

describe("streaming tool events", () => {
  it("yields progress and update events from tool execution", async () => {
    const tools = [makeStreamingTool("stream")];
    const calls = [{ id: "tc-1", name: "stream", args: {} }];

    const { events } = await collectEvents(
      executeToolCalls(tools, calls, AbortSignal.timeout(5000), {
        type: "sequential",
      }),
    );

    const types = events.map((e) => e.props.type);
    expect(types).toContain("agent:tool-progress");
    expect(types).toContain("agent:tool-update");
    expect(types).toContain("agent:tool-result");

    const progressEvents = events.filter(
      (e) => e.props.type === "agent:tool-progress",
    );
    expect(progressEvents.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Steering
// ---------------------------------------------------------------------------

describe("steering during tool execution", () => {
  it("skips remaining tools when steering message arrives (sequential)", async () => {
    let callCount = 0;
    const tools: AgentTool[] = [
      {
        name: "counter",
        label: "counter",
        description: "counts calls",
        parametersSchema: { type: "object", properties: {} },
        async execute(): Promise<ToolOutput> {
          callCount++;
          return { text: `call-${callCount}` };
        },
      },
    ];

    const calls = [
      { id: "tc-1", name: "counter", args: {} },
      { id: "tc-2", name: "counter", args: {} },
      { id: "tc-3", name: "counter", args: {} },
    ];

    let steeringCalled = false;
    const getSteering = () => {
      if (!steeringCalled) {
        steeringCalled = true;
        return [
          { role: "user" as const, content: "Stop!", timestamp: Date.now() },
        ];
      }
      return [];
    };

    const { result } = await collectEvents(
      executeToolCalls(
        tools,
        calls,
        AbortSignal.timeout(5000),
        { type: "sequential" },
        getSteering,
      ),
    );

    // Only the first tool should have actually executed
    expect(callCount).toBe(1);

    const toolResult = result as {
      toolResults: unknown[];
      steeringMessages?: unknown[];
    };
    // All 3 should have results (1 real + 2 skipped)
    expect(toolResult.toolResults).toHaveLength(3);
    expect(toolResult.steeringMessages).toHaveLength(1);
  });
});
