import type { LlmApi, StreamPart } from "@statewalker/ai";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.js";
import type { AgentTool } from "../src/types.js";
import {
  createAgentNodeFactory,
  type Message,
  type Session,
} from "../src/wrappers/index.js";

function makeSession(): Session {
  const factory = createAgentNodeFactory();
  return factory({ type: "session" }) as Session;
}

function mockLlm(...responses: StreamPart[][]): LlmApi {
  let call = 0;
  return {
    connect() {},
    disconnect() {},
    registerTools() {
      return () => {};
    },
    getRegisteredTools() {
      return {};
    },
    async *streamChatCompletion() {
      const parts = responses[call++] ?? [];
      for (const part of parts) {
        yield part;
      }
    },
    async generateText() {
      return "";
    },
    async generateObject() {
      return {} as never;
    },
  };
}

describe("agentLoop", () => {
  it("writes simple text response to tree", async () => {
    const session = makeSession();
    const turn = session.addTurn();
    turn.addUserMessage("Hello");

    const llm = mockLlm([
      { type: "text-delta", textDelta: "Hi " },
      { type: "text-delta", textDelta: "there" },
      { type: "step-finish", finishReason: "stop" },
    ]);

    await agentLoop({
      session,
      llm,
      model: "test",
      systemPrompt: "Be helpful",
      tools: [],
    });

    expect(turn.messages).toHaveLength(2); // user + agent
    const agent = turn.messages[1] as Message;
    expect(agent.text).toBe("Hi there");
    expect(turn.stopReason).toBe("stop");
    expect(turn.model).toBe("test");
  });

  it("handles thinking blocks", async () => {
    const session = makeSession();
    const turn = session.addTurn();
    turn.addUserMessage("Think");

    const llm = mockLlm([
      { type: "reasoning", textDelta: "Let me think" },
      { type: "text-delta", textDelta: "Answer" },
      { type: "step-finish", finishReason: "stop" },
    ]);

    await agentLoop({
      session,
      llm,
      model: "test",
      systemPrompt: "",
      tools: [],
    });

    const agent = turn.messages[1] as Message;
    expect(agent.thinkingBlocks).toHaveLength(1);
    expect(agent.thinkingBlocks[0]?.text).toBe("Let me think");
    expect(agent.text).toBe("Answer");
  });

  it("executes tool calls and loops back to LLM", async () => {
    const session = makeSession();
    const turn = session.addTurn();
    turn.addUserMessage("Read file");

    const llm = mockLlm(
      // First LLM call: tool call
      [
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "read",
          args: { path: "/tmp" },
        },
        { type: "step-finish", finishReason: "tool-calls" },
      ],
      // Second LLM call: final response
      [
        { type: "text-delta", textDelta: "File says hello" },
        { type: "step-finish", finishReason: "stop" },
      ],
    );

    const tools: AgentTool[] = [
      {
        name: "read",
        label: "Read",
        description: "Read file",
        parametersSchema: {},
        async execute() {
          return { text: "hello" };
        },
      },
    ];

    await agentLoop({
      session,
      llm,
      model: "test",
      systemPrompt: "",
      tools,
    });

    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0]?.result).toBe("hello");
    // Should have agent messages from second LLM call
    const agentMsgs = turn.messages.filter((m) => m.role === "assistant");
    expect(agentMsgs.length).toBeGreaterThanOrEqual(1);
  });

  it("handles LLM error gracefully", async () => {
    const session = makeSession();
    const turn = session.addTurn();
    turn.addUserMessage("Fail");

    const llm = mockLlm();
    llm.streamChatCompletion = () => {
      throw new Error("LLM broke");
    };

    await agentLoop({
      session,
      llm,
      model: "test",
      systemPrompt: "",
      tools: [],
    });

    expect(turn.stopReason).toBe("error");
    expect(turn.errors).toHaveLength(1);
    expect(turn.errors[0]?.content).toBe("LLM broke");
  });

  it("handles abort signal", async () => {
    const session = makeSession();
    const turn = session.addTurn();
    turn.addUserMessage("Slow");

    const abort = new AbortController();

    const llm = mockLlm();
    llm.streamChatCompletion = async function* () {
      yield { type: "text-delta" as const, textDelta: "Start" };
      abort.abort();
      yield { type: "text-delta" as const, textDelta: " more" };
    };

    await agentLoop({
      session,
      llm,
      model: "test",
      systemPrompt: "",
      tools: [],
      signal: abort.signal,
    });

    expect(turn.stopReason).toBe("aborted");
  });

  it("uses custom selection strategy", async () => {
    const session = makeSession();
    // Old turn that should be excluded
    const t1 = session.addTurn();
    t1.addUserMessage("Old message");
    t1.addAgentMessage().appendDelta("Old reply");

    // Current turn
    const t2 = session.addTurn();
    t2.addUserMessage("New message");

    let receivedMessageCount = 0;
    const llm = mockLlm();
    llm.streamChatCompletion = async function* (opts) {
      receivedMessageCount = opts.messages.length;
      yield { type: "text-delta" as const, textDelta: "Reply" };
      yield { type: "step-finish" as const, finishReason: "stop" };
    };

    await agentLoop({
      session,
      llm,
      model: "test",
      systemPrompt: "",
      tools: [],
      select: async function* (s) {
        // Only yield messages from the last turn
        const lastTurn = s.turns[s.turns.length - 1];
        if (lastTurn) {
          const { flattenTurn } = await import("../src/flatten.js");
          yield* flattenTurn(lastTurn);
        }
      },
    });

    // Should only have received 1 message (from t2), not 3 (from both turns)
    expect(receivedMessageCount).toBe(1);
  });

  it("returns immediately if no current turn", async () => {
    const session = makeSession();
    const llm = mockLlm();

    await agentLoop({
      session,
      llm,
      model: "test",
      systemPrompt: "",
      tools: [],
    });
    // No error, just returns
  });
});
