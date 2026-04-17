import { describe, expect, it } from "vitest";
import { convertPrompt } from "../src/prompt-converter.js";

describe("convertPrompt", () => {
  it("converts system + user + assistant messages", () => {
    const out = convertPrompt([
      { role: "system", content: "sys" },
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ]);
    expect(out).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
  });

  it("concatenates multiple text parts in a user message", () => {
    const out = convertPrompt([
      {
        role: "user",
        content: [
          { type: "text", text: "one " },
          { type: "text", text: "two" },
        ],
      },
    ]);
    expect(out[0]?.content).toBe("one two");
  });

  it("emits tool_calls on assistant messages", () => {
    const out = convertPrompt([
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "getWeather",
            input: { city: "Paris" },
          },
        ],
      },
    ]);
    expect(out[0]).toMatchObject({
      role: "assistant",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "getWeather",
            arguments: '{"city":"Paris"}',
          },
        },
      ],
    });
  });

  it("emits tool messages with tool_call_id", () => {
    const out = convertPrompt([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "getWeather",
            output: { type: "json", value: { temp: 12 } },
          },
        ],
      },
    ]);
    expect(out[0]).toMatchObject({
      role: "tool",
      tool_call_id: "call_1",
      name: "getWeather",
      content: '{"temp":12}',
    });
  });

  it("passes through string-shaped tool inputs without re-stringifying", () => {
    const out = convertPrompt([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "f",
            input: '{"raw":true}',
          },
        ],
      },
    ]);
    expect(out[0]?.tool_calls?.[0]?.function.arguments).toBe('{"raw":true}');
  });
});
