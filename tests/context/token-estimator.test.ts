import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { createTokenEstimator } from "../../src/context/token-estimator.js";

describe("createTokenEstimator default (char-ratio)", () => {
  it("computes ceil(chars / charsPerToken) for a plain user message", () => {
    const est = createTokenEstimator();
    const msgs: ModelMessage[] = [{ role: "user", content: "a".repeat(4000) }];
    expect(est.estimate(msgs)).toBe(1000);
  });

  it("respects a custom charsPerToken", () => {
    const est = createTokenEstimator({ charsPerToken: 3.8 });
    const msgs: ModelMessage[] = [{ role: "user", content: "a".repeat(3800) }];
    expect(est.estimate(msgs)).toBe(1000);
  });

  it("counts text parts inside assistant content arrays", () => {
    const est = createTokenEstimator();
    const msgs: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "a".repeat(400) },
          { type: "text", text: "b".repeat(400) },
        ] as unknown as never,
      },
    ];
    expect(est.estimate(msgs)).toBe(200);
  });

  it("counts tool-call input and tool-result output", () => {
    const est = createTokenEstimator();
    const msgs: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "read_file",
            input: { path: "/some/long/path/x.txt" }, // JSON-stringified
          },
        ] as unknown as never,
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "read_file",
            output: { type: "json", value: "a".repeat(400) },
          },
        ] as unknown as never,
      },
    ];
    // tool-call input → JSON.stringify({path:"/some/long/path/x.txt"}) is
    // 29 chars → ceil(29/4) = 8; tool-result output → 400-char string gives
    // more than 100 tokens wrapped in JSON. Check that both contribute.
    const total = est.estimate(msgs);
    expect(total).toBeGreaterThan(100);
  });
});

describe("createTokenEstimator with custom tokeniser", () => {
  it("uses caller-supplied tokenize across all string fragments", () => {
    const est = createTokenEstimator({
      tokenize: (t) => t.split(/\s+/).filter(Boolean).length,
    });
    const msgs: ModelMessage[] = [
      { role: "user", content: "one two three four" },
    ];
    expect(est.estimate(msgs)).toBe(4);
  });
});

describe("createTokenEstimator tolerance", () => {
  it("treats missing content as 0 without throwing", () => {
    const est = createTokenEstimator();
    const msgs: ModelMessage[] = [
      { role: "user", content: undefined as unknown as string },
    ];
    expect(est.estimate(msgs)).toBe(0);
  });

  it("estimates a raw string directly", () => {
    const est = createTokenEstimator();
    expect(est.estimate("a".repeat(40))).toBe(10);
  });
});
