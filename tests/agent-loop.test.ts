import type { LlmApi, StreamPart } from "@statewalker/ai";
import { describe, expect, it } from "vitest";
import type { AgentContext, AgentLoopConfig } from "../src/agent/agent-loop.js";
import { agentLoop, agentLoopContinue } from "../src/agent/agent-loop.js";
import type { AgentEvent } from "../src/events/agent-events.js";
import { userMessage } from "../src/events/agent-events.js";
import type {
  AgentTool,
  ToolContext,
  ToolOutput,
} from "../src/tools/agent-tool.js";

// ---------------------------------------------------------------------------
// Mock LLM
// ---------------------------------------------------------------------------

type MockResponse =
  | { type: "text"; text: string }
  | { type: "tool-calls"; calls: Array<{ name: string; args: unknown }> }
  | { type: "error"; message: string };

function createMockLlm(responses: MockResponse[]): LlmApi {
  let callIndex = 0;

  return {
    connect() {},
    disconnect() {},
    registerTools() {
      return () => {};
    },
    getRegisteredTools() {
      return {};
    },
    async *streamChatCompletion(): AsyncGenerator<StreamPart> {
      const response = responses[callIndex++];
      if (!response) {
        yield { type: "text-delta", textDelta: "(no more responses)" };
        yield { type: "step-finish", finishReason: "stop" };
        return;
      }

      switch (response.type) {
        case "text":
          yield { type: "text-delta", textDelta: response.text };
          yield { type: "step-finish", finishReason: "stop" };
          break;

        case "tool-calls":
          for (const [i, call] of response.calls.entries()) {
            yield {
              type: "tool-call",
              toolCallId: `tc-${callIndex}-${i}`,
              toolName: call.name,
              args: (call.args ?? {}) as Record<string, unknown>,
            };
          }
          yield { type: "step-finish", finishReason: "tool-calls" };
          break;

        case "error":
          throw new Error(response.message);
      }
    },
    async generateText() {
      return "mock text";
    },
    async generateObject() {
      return {} as never;
    },
  };
}

function makeTool(
  name: string,
  handler: (args: unknown) => string | Promise<string>,
): AgentTool {
  return {
    name,
    label: name,
    description: `Mock tool: ${name}`,
    parametersSchema: {
      type: "object",
      properties: { input: { type: "string" } },
    },
    async execute(params: unknown, _ctx: ToolContext): Promise<ToolOutput> {
      const result = await handler(params);
      return { text: result };
    },
  };
}

async function collectEvents(
  gen: AsyncGenerator<AgentEvent>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

function eventTypes(events: AgentEvent[]): string[] {
  return events.map((e) => e.props.type);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("agentLoop — text response", () => {
  it("yields start, turn-start, assistant, text-delta, turn-end, end", async () => {
    const llm = createMockLlm([{ type: "text", text: "Hello!" }]);
    const context: AgentContext = {
      systemPrompt: "You are helpful.",
      messages: [],
      tools: [],
    };
    const config: AgentLoopConfig = {
      llm,
      model: "mock-model",
      systemPrompt: "You are helpful.",
      tools: [],
    };

    const events = await collectEvents(
      agentLoop([userMessage("Hi")], context, config),
    );
    const types = eventTypes(events);

    expect(types[0]).toBe("agent:start");
    expect(types).toContain("agent:turn-start");
    expect(types).toContain("agent:assistant");
    expect(types).toContain("agent:text-delta");
    expect(types).toContain("agent:turn-end");
    expect(types[types.length - 1]).toBe("agent:end");

    // Context should have user + assistant messages
    expect(context.messages).toHaveLength(2);
    expect(context.messages[0]?.role).toBe("user");
    expect(context.messages[1]?.role).toBe("assistant");
  });

  it("text-delta contains the response text", async () => {
    const llm = createMockLlm([{ type: "text", text: "World" }]);
    const context: AgentContext = {
      systemPrompt: "",
      messages: [],
      tools: [],
    };

    const events = await collectEvents(
      agentLoop([userMessage("Hi")], context, {
        llm,
        model: "m",
        systemPrompt: "",
        tools: [],
      }),
    );

    const textDelta = events.find((e) => e.props.type === "agent:text-delta");
    expect(textDelta?.blocks[0]?.content).toBe("World");
  });
});

describe("agentLoop — tool calling", () => {
  it("executes tool calls and loops back to LLM", async () => {
    const llm = createMockLlm([
      {
        type: "tool-calls",
        calls: [{ name: "greet", args: { input: "world" } }],
      },
      { type: "text", text: "Done!" },
    ]);

    const greetTool = makeTool("greet", (args) => {
      const a = args as { input: string };
      return `Hello, ${a.input}!`;
    });

    const context: AgentContext = {
      systemPrompt: "",
      messages: [],
      tools: [greetTool],
    };
    const config: AgentLoopConfig = {
      llm,
      model: "m",
      systemPrompt: "",
      tools: [greetTool],
    };

    const events = await collectEvents(
      agentLoop([userMessage("Greet the world")], context, config),
    );
    const types = eventTypes(events);

    // Should have two turns
    const turnStarts = types.filter((t) => t === "agent:turn-start");
    expect(turnStarts.length).toBe(2);

    // Tool call + tool result events
    expect(types).toContain("agent:tool-call");
    expect(types).toContain("agent:tool-result");

    // Final text response
    const textDeltas = events.filter(
      (e) => e.props.type === "agent:text-delta",
    );
    expect(textDeltas.length).toBeGreaterThanOrEqual(1);

    // Context should have: user, assistant(tool-call), tool-result, assistant(text)
    expect(context.messages).toHaveLength(4);
    expect(context.messages[0]?.role).toBe("user");
    expect(context.messages[1]?.role).toBe("assistant");
    expect(context.messages[2]?.role).toBe("tool-result");
    expect(context.messages[3]?.role).toBe("assistant");
  });
});

describe("agentLoop — error handling", () => {
  it("yields error event on LLM failure", async () => {
    const llm = createMockLlm([{ type: "error", message: "API rate limit" }]);
    const context: AgentContext = {
      systemPrompt: "",
      messages: [],
      tools: [],
    };

    const events = await collectEvents(
      agentLoop([userMessage("Hi")], context, {
        llm,
        model: "m",
        systemPrompt: "",
        tools: [],
      }),
    );
    const types = eventTypes(events);

    expect(types).toContain("agent:error");

    const errorEvent = events.find((e) => e.props.type === "agent:error");
    expect(errorEvent?.blocks[0]?.content).toContain("API rate limit");
  });

  it("calls onError callback", async () => {
    const llm = createMockLlm([{ type: "error", message: "boom" }]);
    const errors: string[] = [];

    await collectEvents(
      agentLoop(
        [userMessage("Hi")],
        { systemPrompt: "", messages: [], tools: [] },
        {
          llm,
          model: "m",
          systemPrompt: "",
          tools: [],
          onError: (err) => errors.push(err),
        },
      ),
    );

    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("boom");
  });
});

describe("agentLoop — input filters", () => {
  it("rejects input when filter returns reject", async () => {
    const llm = createMockLlm([{ type: "text", text: "never reached" }]);
    const context: AgentContext = {
      systemPrompt: "",
      messages: [],
      tools: [],
    };

    const events = await collectEvents(
      agentLoop([userMessage("bad input")], context, {
        llm,
        model: "m",
        systemPrompt: "",
        tools: [],
        inputFilters: [
          {
            filter: () => ({ type: "reject", reason: "blocked" }),
          },
        ],
      }),
    );
    const types = eventTypes(events);

    expect(types).toContain("agent:input-rejected");
    expect(types).not.toContain("agent:turn-start");
  });

  it("passes input with warning appended", async () => {
    const llm = createMockLlm([{ type: "text", text: "ok" }]);
    const context: AgentContext = {
      systemPrompt: "",
      messages: [],
      tools: [],
    };

    const events = await collectEvents(
      agentLoop([userMessage("test")], context, {
        llm,
        model: "m",
        systemPrompt: "",
        tools: [],
        inputFilters: [
          {
            filter: () => ({ type: "warn", message: "be careful" }),
          },
        ],
      }),
    );
    const types = eventTypes(events);

    expect(types).toContain("agent:text-delta");
    // Warning should be appended to user message
    const userMsg = context.messages.find((m) => m.role === "user");
    expect(typeof userMsg?.content === "string" && userMsg.content).toContain(
      "be careful",
    );
  });
});

describe("agentLoop — execution limits", () => {
  it("stops when max turns exceeded", async () => {
    // LLM always requests a tool call, creating an infinite loop
    const responses: MockResponse[] = Array.from({ length: 10 }, () => ({
      type: "tool-calls" as const,
      calls: [{ name: "noop", args: {} }],
    }));
    const llm = createMockLlm(responses);

    const noopTool = makeTool("noop", () => "ok");
    const context: AgentContext = {
      systemPrompt: "",
      messages: [],
      tools: [noopTool],
    };

    const events = await collectEvents(
      agentLoop([userMessage("go")], context, {
        llm,
        model: "m",
        systemPrompt: "",
        tools: [noopTool],
        executionLimits: {
          maxTurns: 3,
          maxTotalTokens: 1_000_000,
          maxDurationMs: 60_000,
        },
      }),
    );
    const types = eventTypes(events);

    expect(types).toContain("agent:error");
    const errorEvent = events.find((e) => e.props.type === "agent:error");
    expect(errorEvent?.blocks[0]?.content).toContain("Max turns");
  });
});

describe("agentLoop — beforeTurn callback", () => {
  it("aborts when beforeTurn returns false", async () => {
    const llm = createMockLlm([
      { type: "text", text: "turn 1" },
      { type: "text", text: "turn 2" },
    ]);

    const context: AgentContext = {
      systemPrompt: "",
      messages: [],
      tools: [],
    };

    const events = await collectEvents(
      agentLoop([userMessage("Hi")], context, {
        llm,
        model: "m",
        systemPrompt: "",
        tools: [],
        beforeTurn: (_msgs, turn) => turn <= 1,
      }),
    );
    const types = eventTypes(events);

    // Should only have one turn
    const turnStarts = types.filter((t) => t === "agent:turn-start");
    expect(turnStarts.length).toBe(1);
  });
});

describe("agentLoop — follow-up messages", () => {
  it("processes follow-up messages after main loop", async () => {
    const llm = createMockLlm([
      { type: "text", text: "first response" },
      { type: "text", text: "follow-up response" },
    ]);

    let followUpCalled = false;
    const context: AgentContext = {
      systemPrompt: "",
      messages: [],
      tools: [],
    };

    const events = await collectEvents(
      agentLoop([userMessage("Hi")], context, {
        llm,
        model: "m",
        systemPrompt: "",
        tools: [],
        getFollowUpMessages: () => {
          if (!followUpCalled) {
            followUpCalled = true;
            return [userMessage("Follow up!")];
          }
          return [];
        },
      }),
    );
    const types = eventTypes(events);

    // Should have two turns (original + follow-up)
    const turnStarts = types.filter((t) => t === "agent:turn-start");
    expect(turnStarts.length).toBe(2);

    // Context should have 4 messages (user, assistant, follow-up user, assistant)
    expect(context.messages).toHaveLength(4);
  });
});

describe("agentLoopContinue", () => {
  it("continues from existing context", async () => {
    const llm = createMockLlm([{ type: "text", text: "continued" }]);
    const context: AgentContext = {
      systemPrompt: "You are helpful.",
      messages: [
        userMessage("Original question"),
        {
          role: "assistant",
          content: "Original answer",
          timestamp: Date.now(),
          stopReason: "stop",
          model: "m",
        },
      ],
      tools: [],
    };

    const _events = await collectEvents(
      agentLoopContinue(context, {
        llm,
        model: "m",
        systemPrompt: "",
        tools: [],
      }),
    );
    const types = eventTypes(_events);

    expect(types[0]).toBe("agent:start");
    expect(types).toContain("agent:text-delta");
    expect(types[types.length - 1]).toBe("agent:end");
  });
});

describe("agentLoop — event structure (ContentMessage compatibility)", () => {
  it("all events have props.time, props.role, props.type and blocks array", async () => {
    const llm = createMockLlm([{ type: "text", text: "ok" }]);
    const events = await collectEvents(
      agentLoop(
        [userMessage("test")],
        { systemPrompt: "", messages: [], tools: [] },
        { llm, model: "m", systemPrompt: "", tools: [] },
      ),
    );

    for (const event of events) {
      expect(event.props).toBeDefined();
      expect(typeof event.props.time).toBe("string");
      expect(typeof event.props.role).toBe("string");
      expect(typeof event.props.type).toBe("string");
      expect(Array.isArray(event.blocks)).toBe(true);
      expect(event.blocks.length).toBeGreaterThanOrEqual(1);

      // All prop values should be string | undefined (ContentProps constraint)
      for (const [, value] of Object.entries(event.props)) {
        expect(typeof value === "string" || typeof value === "undefined").toBe(
          true,
        );
      }
    }
  });
});

describe("Agent class", () => {
  it("wraps agentLoop with builder pattern", async () => {
    const { Agent } = await import("../src/agent/agent.js");
    const llm = createMockLlm([{ type: "text", text: "Hi there!" }]);

    const agent = new Agent(llm)
      .withSystemPrompt("You are helpful.")
      .withModel("mock")
      .withoutContextManagement();

    const events: AgentEvent[] = [];
    for await (const event of agent.prompt("Hello")) {
      events.push(event);
    }

    const types = eventTypes(events);
    expect(types[0]).toBe("agent:start");
    expect(types).toContain("agent:text-delta");
    expect(types[types.length - 1]).toBe("agent:end");

    expect(agent.getMessages()).toHaveLength(2);
    expect(agent.isRunning()).toBe(false);
  });

  it("supports save/restore messages", async () => {
    const { Agent } = await import("../src/agent/agent.js");
    const llm = createMockLlm([{ type: "text", text: "saved" }]);

    const agent = new Agent(llm).withModel("m").withoutContextManagement();

    for await (const _ of agent.prompt("test")) {
      // drain
    }

    const json = agent.saveMessages();
    const parsed = JSON.parse(json);
    expect(parsed).toHaveLength(2);

    const agent2 = new Agent(llm).withModel("m").withoutContextManagement();
    agent2.restoreMessages(json);
    expect(agent2.getMessages()).toHaveLength(2);
  });

  it("throws if prompted while running", async () => {
    const { Agent } = await import("../src/agent/agent.js");
    const llm = createMockLlm([{ type: "text", text: "ok" }]);
    const agent = new Agent(llm).withModel("m").withoutContextManagement();

    // Start but don't drain
    const gen = agent.prompt("Hi");
    // Force into running state
    await gen.next();

    await expect(async () => {
      for await (const _ of agent.prompt("Again")) {
        // should throw
      }
    }).rejects.toThrow("already running");

    // Drain original to clean up
    let next = await gen.next();
    while (!next.done) next = await gen.next();
  });
});
