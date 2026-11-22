// The model context as the agent loop's initial messages (statewalker/statewalker-root#131).
import type { ContextEntry, Item } from "@statewalker/ai-sessions";
import { describe, expect, it } from "vitest";
import { contextMessages, SUMMARY_MESSAGE_START } from "../src/context.js";

const MODEL = { api: "openai-completions", provider: "deployment", id: "m" };
const item = (seq: number, rest: Partial<Item>): ContextEntry => ({
  type: "item",
  item: { seq, id: `it-${seq}`, turn: "s.tu-1", kind: "message", ...rest } as Item,
});

describe("context messages", () => {
  it("turn summaries into user messages and items into user, assistant and tool-result messages", () => {
    const messages = contextMessages(
      [
        {
          type: "summary",
          summary: {
            id: "su-1",
            depth: 1,
            from_seq: 1,
            to_seq: 2,
            content: "Earlier: hello.",
            sections: [{ title: "Goal", body: "greet", refs: ["it-1"] }],
            tokens: 4,
            through_turn: "s.tu-0",
            created: 0,
          },
        },
        item(3, { role: "user", text: "read it" }),
        item(4, { role: "assistant", text: "Reading." }),
        item(5, { kind: "tool_call", callId: "c1", name: "read", args: { path: "/a" } }),
        item(6, { kind: "tool_result", callId: "c1", name: "read", output: "A", isError: false }),
        item(7, { kind: "approval", approval: "ap-1" }),
        item(8, {
          kind: "tool_result",
          approval: "ap-1",
          output: "write /a: done",
          isError: false,
        }),
        item(9, { role: "assistant", text: "Done." }),
      ],
      MODEL,
    );
    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "user",
      "assistant",
      "toolResult",
      "user",
      "assistant",
    ]);
    expect(messages[0]).toMatchObject({
      content: `${SUMMARY_MESSAGE_START}\nEarlier: hello.\n## Goal\ngreet`,
    });
    expect(messages[2]).toMatchObject({
      content: [
        { type: "text", text: "Reading." },
        { type: "toolCall", id: "c1", name: "read", arguments: { path: "/a" } },
      ],
      stopReason: "toolUse",
      api: "openai-completions",
      provider: "deployment",
      model: "m",
    });
    expect(messages[3]).toMatchObject({ toolCallId: "c1", content: [{ text: "A" }] });
    // A result with no call before it (an approved action run again) is told as a message.
    expect(messages[4]).toMatchObject({ content: "[Result of an approved action] write /a: done" });
  });

  it("tells a denied action's result as a denial, with its reason", () => {
    const messages = contextMessages(
      [
        item(1, {
          kind: "tool_result",
          approval: "ap-1",
          output: "write /a: denied by the user: not there",
          isError: true,
          denied: true,
        }),
      ],
      MODEL,
    );
    expect(messages).toMatchObject([
      {
        role: "user",
        content: "[Result of a denied action] write /a: denied by the user: not there",
      },
    ]);
  });
});
