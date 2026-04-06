import { describe, expect, it } from "vitest";
import { selectAll } from "../src/context/select-messages.js";
import { createAgentNodeFactory, type Session } from "../src/state/index.js";

function makeSession(): Session {
  const factory = createAgentNodeFactory();
  return factory({ type: "session" }) as Session;
}

describe("selectAll", () => {
  it("returns user and agent messages", async () => {
    const session = makeSession();
    const turn = session.addTurn();
    turn.addUserMessage("Hello");
    const msg = turn.addAgentMessage();
    msg.appendDelta("Hi there");

    const result = await selectAll(session);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: "user", content: "Hello" });
    expect(result[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Hi there" }],
    });
  });

  it("includes tool calls with responses", async () => {
    const session = makeSession();
    const turn = session.addTurn();
    turn.addUserMessage("Read /tmp");
    const msg = turn.addAgentMessage();
    msg.appendDelta("Let me check");
    const tc = turn.addToolCall("c1", "read", { path: "/tmp" });
    tc.addResponse("file contents");

    const result = await selectAll(session);
    expect(result).toHaveLength(3);

    expect(result[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Let me check" },
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "read",
          input: { path: "/tmp" },
        },
      ],
    });

    expect(result[2]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "read",
          output: { type: "json", value: "file contents" },
        },
      ],
    });
  });

  it("includes reasoning parts for prompt reconstruction", async () => {
    const session = makeSession();
    const turn = session.addTurn();
    turn.addUserMessage("Think about this");
    const msg = turn.addAgentMessage();
    const thinking = msg.addThinkingBlock();
    thinking.appendDelta("Let me reason");
    msg.appendDelta("Here's my answer");

    const result = await selectAll(session);
    expect(result[1]).toEqual({
      role: "assistant",
      content: [
        { type: "reasoning", text: "Let me reason" },
        { type: "text", text: "Here's my answer" },
      ],
    });
  });

  it("handles multi-turn sessions", async () => {
    const session = makeSession();

    const t1 = session.addTurn();
    t1.addUserMessage("First");
    t1.addAgentMessage().appendDelta("Reply 1");

    const t2 = session.addTurn();
    t2.addUserMessage("Second");
    t2.addAgentMessage().appendDelta("Reply 2");

    const result = await selectAll(session);
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({ role: "user", content: "First" });
    expect(result[2]).toEqual({ role: "user", content: "Second" });
  });

  it("returns empty array for empty session", async () => {
    const session = makeSession();
    expect(await selectAll(session)).toEqual([]);
  });
});
