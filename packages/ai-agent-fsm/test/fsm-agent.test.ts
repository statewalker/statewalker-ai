import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// Mock the 'ai' module
vi.mock("ai", () => ({
  streamText: vi.fn(),
  tool: vi.fn((def: any) => def),
}));

import { streamText } from "ai";
import { FsmAgent } from "../src/fsm-agent.js";
import type { AgentConfig, AgentEvent, AgentTool } from "../src/types.js";

// Helper to create a mock stream result
function mockStreamResult(parts: any[], finishReason = "stop") {
  return {
    fullStream: (async function* () {
      for (const part of parts) yield part;
    })(),
    usage: Promise.resolve({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    }),
    finishReason: Promise.resolve(finishReason),
  };
}

// Helper to collect all events from the agent
async function collectEvents(
  gen: AsyncGenerator<AgentEvent>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

const mockModel = { modelId: "test-model" } as AgentConfig["model"];

describe("FsmAgent", () => {
  beforeEach(() => {
    vi.mocked(streamText).mockReset();
  });

  it("produces text response with no tools", async () => {
    vi.mocked(streamText).mockReturnValueOnce(
      mockStreamResult([
        { type: "text-delta", text: "Hello" },
        { type: "text-delta", text: " world" },
      ]) as any,
    );

    const agent = new FsmAgent({ model: mockModel });
    const events = await collectEvents(agent.run("Hi"));

    // Should include turn-start, two text-deltas, done with finishReason, turn-end, and final done
    const types = events.map((e) => e.type);
    expect(types).toContain("turn-start");
    expect(types).toContain("text-delta");
    expect(types).toContain("done");

    const textDeltas = events.filter((e) => e.type === "text-delta");
    expect(textDeltas).toHaveLength(2);
    expect(textDeltas[0]?.text).toBe("Hello");
    expect(textDeltas[1]?.text).toBe(" world");

    // Context should have user + assistant messages
    expect(agent.context.messages).toHaveLength(2);
    expect(agent.context.messages[0]?.role).toBe("user");
    expect(agent.context.messages[0]?.content).toBe("Hi");
    expect(agent.context.messages[1]?.role).toBe("assistant");
    expect(agent.context.messages[1]?.content).toBe("Hello world");
  });

  it("handles tool call and re-generation", async () => {
    const echoTool: AgentTool = {
      name: "echo",
      description: "Echo",
      parameters: z.object({ text: z.string() }),
      execute: async (params: any) => `Echo: ${params.text}`,
    };

    // First call: model invokes the echo tool
    vi.mocked(streamText).mockReturnValueOnce(
      mockStreamResult(
        [
          {
            type: "tool-call",
            toolCallId: "tc1",
            toolName: "echo",
            args: { text: "hi" },
          },
        ],
        "tool-calls",
      ) as any,
    );

    // Second call: model produces text after seeing tool result
    vi.mocked(streamText).mockReturnValueOnce(
      mockStreamResult([{ type: "text-delta", text: "Done" }]) as any,
    );

    const agent = new FsmAgent({ model: mockModel, tools: [echoTool] });
    const events = await collectEvents(agent.run("Say hi"));

    const types = events.map((e) => e.type);
    expect(types).toContain("turn-start");
    expect(types).toContain("tool-call");
    expect(types).toContain("tool-result");
    expect(types).toContain("text-delta");
    expect(types).toContain("done");

    const toolCallEvent = events.find((e) => e.type === "tool-call");
    expect(toolCallEvent?.toolCall?.toolName).toBe("echo");
    expect(toolCallEvent?.toolCall?.args).toEqual({ text: "hi" });

    const toolResultEvent = events.find((e) => e.type === "tool-result");
    expect(toolResultEvent?.toolResult?.output).toBe("Echo: hi");
    expect(toolResultEvent?.toolResult?.isError).toBeUndefined();

    const textDelta = events.find((e) => e.type === "text-delta");
    expect(textDelta?.text).toBe("Done");

    // Messages: user, assistant+toolCall, tool-result, assistant
    expect(agent.context.messages).toHaveLength(4);
    expect(agent.context.messages[0]?.role).toBe("user");
    expect(agent.context.messages[1]?.role).toBe("assistant");
    expect(agent.context.messages[1]?.toolCalls).toHaveLength(1);
    expect(agent.context.messages[2]?.role).toBe("tool");
    expect(agent.context.messages[3]?.role).toBe("assistant");
  });

  it("respects maxTurns limit", async () => {
    // With maxTurns: 0 and turn incrementing to 1, it exceeds the limit
    const agent = new FsmAgent({ model: mockModel, maxTurns: 0 });
    const events = await collectEvents(agent.run("Hi"));

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.error).toBe("Max turns exceeded");
  });

  it("handles tool execution errors", async () => {
    const failingTool: AgentTool = {
      name: "fail",
      description: "Always fails",
      parameters: z.object({ input: z.string() }),
      execute: async () => {
        throw new Error("Tool crashed");
      },
    };

    // First call: model invokes the failing tool
    vi.mocked(streamText).mockReturnValueOnce(
      mockStreamResult(
        [
          {
            type: "tool-call",
            toolCallId: "tc-fail",
            toolName: "fail",
            args: { input: "boom" },
          },
        ],
        "tool-calls",
      ) as any,
    );

    // Second call: model sees the error and responds with text
    vi.mocked(streamText).mockReturnValueOnce(
      mockStreamResult([
        { type: "text-delta", text: "Something went wrong" },
      ]) as any,
    );

    const agent = new FsmAgent({ model: mockModel, tools: [failingTool] });
    const events = await collectEvents(agent.run("Do it"));

    const toolResultEvent = events.find((e) => e.type === "tool-result");
    expect(toolResultEvent).toBeDefined();
    expect(toolResultEvent?.toolResult?.isError).toBe(true);
    expect(toolResultEvent?.toolResult?.output).toContain("Tool crashed");

    // The agent should still produce a text response after the error
    const textDelta = events.find((e) => e.type === "text-delta");
    expect(textDelta).toBeDefined();
    expect(textDelta?.text).toBe("Something went wrong");
  });

  it("dump and restore preserves state", async () => {
    vi.mocked(streamText).mockReturnValueOnce(
      mockStreamResult([{ type: "text-delta", text: "First response" }]) as any,
    );

    const agent = new FsmAgent({ model: mockModel });
    await collectEvents(agent.run("First prompt"));

    // Dump the agent state
    const dump = await agent.dump();
    expect(dump.messages).toHaveLength(2); // user + assistant
    expect(dump.turn).toBe(1);
    expect(dump.fsmDump).toBeDefined();
    expect(dump.fsmDump.stack).toBeDefined();

    // Restore into a new agent
    const agent2 = new FsmAgent({ model: mockModel });
    await agent2.restore(dump);

    expect(agent2.context.messages).toHaveLength(2);
    expect(agent2.context.turn).toBe(1);
    expect(agent2.context.messages[0]?.role).toBe("user");
    expect(agent2.context.messages[0]?.content).toBe("First prompt");
    expect(agent2.context.messages[1]?.role).toBe("assistant");
    expect(agent2.context.messages[1]?.content).toBe("First response");
  });
});
