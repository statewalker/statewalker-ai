import { describe, expect, it } from "vitest";
import { convertPrompt } from "../src/prompt-converter.js";

describe("convertPrompt", () => {
  it("converts system message (string content)", () => {
    const result = convertPrompt([{ role: "system", content: "Be helpful" }]);
    expect(result).toEqual([{ role: "system", content: "Be helpful" }]);
  });

  it("converts user message with text parts", () => {
    const result = convertPrompt([
      {
        role: "user",
        content: [
          { type: "text", text: "Hello" },
          { type: "text", text: " world" },
        ],
      },
    ]);
    expect(result).toEqual([{ role: "user", content: "Hello world" }]);
  });

  it("converts system + user messages", () => {
    const result = convertPrompt([
      { role: "system", content: "Be helpful" },
      { role: "user", content: [{ type: "text", text: "Hi" }] },
    ]);
    expect(result).toEqual([
      { role: "system", content: "Be helpful" },
      { role: "user", content: "Hi" },
    ]);
  });

  it("converts assistant message with text", () => {
    const result = convertPrompt([
      {
        role: "assistant",
        content: [{ type: "text", text: "Sure, I can help." }],
      },
    ]);
    expect(result).toEqual([
      { role: "assistant", content: "Sure, I can help." },
    ]);
  });

  it("converts assistant message with tool calls to text", () => {
    const result = convertPrompt([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "tc1",
            toolName: "search",
            input: '{"q":"test"}',
          },
        ],
      },
    ]);
    expect(result[0]?.content).toContain("search");
    expect(result[0]?.content).toContain("test");
  });

  it("converts tool results to user message", () => {
    const result = convertPrompt([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc1",
            toolName: "search",
            output: { type: "text", value: "found it" },
          },
        ],
      },
    ]);
    expect(result[0]?.role).toBe("user");
    expect(result[0]?.content).toContain("search");
  });

  it("skips file parts in user messages", () => {
    const result = convertPrompt([
      {
        role: "user",
        content: [
          { type: "text", text: "Look at this" },
          { type: "file", data: "base64data", mediaType: "image/png" },
        ],
      },
    ]);
    expect(result).toEqual([{ role: "user", content: "Look at this" }]);
  });
});
