import { describe, expect, it } from "vitest";
import { convertPrompt } from "../src/prompt-converter.js";

describe("convertPrompt", () => {
  it("extracts system prompt and last user text", () => {
    const out = convertPrompt([
      { role: "system", content: "you are a helper" },
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);
    expect(out.systemPrompt).toBe("you are a helper");
    expect(out.lastUserText).toBe("hello");
    expect(out.history).toEqual([]);
  });

  it("keeps earlier turns in history and pops the trailing user message", () => {
    const out = convertPrompt([
      { role: "user", content: [{ type: "text", text: "one" }] },
      { role: "assistant", content: [{ type: "text", text: "two" }] },
      { role: "user", content: [{ type: "text", text: "three" }] },
    ]);
    expect(out.lastUserText).toBe("three");
    expect(out.history).toEqual([
      { type: "user", text: "one" },
      { type: "model", text: "two" },
    ]);
  });

  it("concatenates system messages", () => {
    const out = convertPrompt([
      { role: "system", content: "a" },
      { role: "system", content: "b" },
      { role: "user", content: [{ type: "text", text: "q" }] },
    ]);
    expect(out.systemPrompt).toBe("a\n\nb");
  });

  it("inlines tool calls into the model turn text", () => {
    const out = convertPrompt([
      {
        role: "assistant",
        content: [
          { type: "text", text: "reply" },
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "get_weather",
            input: { city: "Paris" },
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: "ok" }] },
    ]);
    const model = out.history.find((h) => h.type === "model");
    expect(model?.text).toContain("[tool_call:get_weather");
    expect(model?.text).toContain('{"city":"Paris"}');
  });

  it("inlines tool results as user turns", () => {
    const out = convertPrompt([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "get_weather",
            output: { type: "json", value: { temp: 12 } },
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ]);
    const toolTurn = out.history[0];
    expect(toolTurn?.type).toBe("user");
    expect(toolTurn?.text).toContain("[tool_result:get_weather");
    expect(toolTurn?.text).toContain('{"temp":12}');
  });
});
