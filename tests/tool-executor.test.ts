import { describe, expect, it, vi } from "vitest";
import { executeTools } from "../src/tool-executor.js";
import type { AgentTool } from "../src/types.js";
import {
  createAgentNodeFactory,
  type Session,
  type ToolCall,
} from "../src/wrappers/index.js";

function makeSession(): Session {
  const factory = createAgentNodeFactory();
  return factory({ type: "session" }) as Session;
}

function makeTool(name: string, handler: AgentTool["execute"]): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parametersSchema: {},
    execute: handler,
  };
}

describe("executeTools", () => {
  it("executes a tool and writes response to tree", async () => {
    const session = makeSession();
    const turn = session.addTurn();
    turn.addToolCall("c1", "greet", { name: "world" });

    const tools = [
      makeTool("greet", async (p) => ({
        text: `Hello ${(p as { name: string }).name}`,
      })),
    ];

    await executeTools(turn, tools, new AbortController().signal);

    const tc = turn.toolCalls[0] as ToolCall;
    expect(tc.result).toBe("Hello world");
    expect(tc.isError).toBe(false);
  });

  it("handles tool not found", async () => {
    const session = makeSession();
    const turn = session.addTurn();
    turn.addToolCall("c1", "missing", {});

    await executeTools(turn, [], new AbortController().signal);

    const tc = turn.toolCalls[0] as ToolCall;
    expect(tc.result).toBe("Tool not found: missing");
    expect(tc.isError).toBe(true);
  });

  it("handles tool execution error", async () => {
    const session = makeSession();
    const turn = session.addTurn();
    turn.addToolCall("c1", "fail", {});

    const tools = [
      makeTool("fail", async () => {
        throw new Error("broken");
      }),
    ];

    await executeTools(turn, tools, new AbortController().signal);

    const tc = turn.toolCalls[0] as ToolCall;
    expect(tc.result).toBe("broken");
    expect(tc.isError).toBe(true);
  });

  it("executes multiple tools in parallel", async () => {
    const session = makeSession();
    const turn = session.addTurn();
    turn.addToolCall("c1", "slow", {});
    turn.addToolCall("c2", "slow", {});

    const order: string[] = [];
    const tools = [
      makeTool("slow", async () => {
        order.push("start");
        await new Promise((r) => setTimeout(r, 10));
        order.push("end");
        return { text: "done" };
      }),
    ];

    await executeTools(turn, tools, new AbortController().signal);

    // Both should start before either ends (parallel)
    expect(order[0]).toBe("start");
    expect(order[1]).toBe("start");
    expect(turn.toolCalls[0]?.result).toBe("done");
    expect(turn.toolCalls[1]?.result).toBe("done");
  });

  it("wires onProgress callback", async () => {
    const session = makeSession();
    const turn = session.addTurn();
    turn.addToolCall("c1", "prog", {});

    const tools = [
      makeTool("prog", async (_p, ctx) => {
        ctx.onProgress?.("loading...");
        return { text: "done" };
      }),
    ];

    await executeTools(turn, tools, new AbortController().signal);

    expect(turn.toolCalls[0]?.progressText).toBe("loading...");
  });

  it("skips tool calls that already have responses", async () => {
    const session = makeSession();
    const turn = session.addTurn();
    const tc = turn.addToolCall("c1", "greet", {});
    tc.addResponse("already done");

    const handler = vi.fn(async () => ({ text: "new" }));
    const tools = [makeTool("greet", handler)];

    await executeTools(turn, tools, new AbortController().signal);

    expect(handler).not.toHaveBeenCalled();
  });
});
