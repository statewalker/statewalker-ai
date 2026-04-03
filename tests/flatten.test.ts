import { describe, expect, it } from "vitest";
import { flattenTurns, selectAll } from "../src/flatten.js";
import { createAgentNodeFactory, type Session } from "../src/wrappers/index.js";

function makeSession(): Session {
  const factory = createAgentNodeFactory();
  return factory({ type: "session" }) as Session;
}

describe("flattenTurns", () => {
  it("flattens user and agent messages", () => {
    const session = makeSession();
    const turn = session.addTurn();
    turn.addUserMessage("Hello");
    const msg = turn.addAgentMessage();
    msg.appendDelta("Hi there");

    const result = flattenTurns([turn]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: "user", content: "Hello" });
    expect(result[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Hi there" }],
    });
  });

  it("flattens tool calls with responses", () => {
    const session = makeSession();
    const turn = session.addTurn();
    turn.addUserMessage("Read /tmp");
    const msg = turn.addAgentMessage();
    msg.appendDelta("Let me check");
    const tc = turn.addToolCall("c1", "read", { path: "/tmp" });
    tc.addResponse("file contents");

    const result = flattenTurns([turn]);
    expect(result).toHaveLength(3);

    // Assistant with text + tool-call
    expect(result[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Let me check" },
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "read",
          args: { path: "/tmp" },
        },
      ],
    });

    // Tool result
    expect(result[2]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "read",
          result: "file contents",
          isError: undefined,
        },
      ],
    });
  });

  it("includes thinking blocks as reasoning parts", () => {
    const session = makeSession();
    const turn = session.addTurn();
    turn.addUserMessage("Think about this");
    const msg = turn.addAgentMessage();
    const thinking = msg.addThinkingBlock();
    thinking.appendDelta("Let me reason");
    msg.appendDelta("Here's my answer");

    const result = flattenTurns([turn]);
    expect(result[1]).toEqual({
      role: "assistant",
      content: [
        { type: "reasoning", text: "Let me reason" },
        { type: "text", text: "Here's my answer" },
      ],
    });
  });

  it("handles multi-turn sessions", () => {
    const session = makeSession();

    const t1 = session.addTurn();
    t1.addUserMessage("First");
    t1.addAgentMessage().appendDelta("Reply 1");

    const t2 = session.addTurn();
    t2.addUserMessage("Second");
    t2.addAgentMessage().appendDelta("Reply 2");

    const result = flattenTurns(session.turns);
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({ role: "user", content: "First" });
    expect(result[2]).toEqual({ role: "user", content: "Second" });
  });

  it("returns empty array for empty turns", () => {
    expect(flattenTurns([])).toEqual([]);
  });
});

describe("selectAll", () => {
  it("yields messages from all turns", async () => {
    const session = makeSession();
    session.addTurn().addUserMessage("Hi");
    session.addTurn().addUserMessage("Bye");

    const messages = [];
    for await (const msg of selectAll(session)) {
      messages.push(msg);
    }
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: "user", content: "Hi" });
    expect(messages[1]).toEqual({ role: "user", content: "Bye" });
  });
});
