import { describe, expect, it } from "vitest";
import type {
  ContextConfig,
  ExecutionLimits,
} from "../src/context/context-manager.js";
import {
  ContextTracker,
  compactMessages,
  ExecutionTracker,
  estimateTokens,
  totalTokens,
} from "../src/context/context-manager.js";
import type { AgentMessage, Usage } from "../src/events/agent-events.js";

function msg(role: "user" | "assistant", text: string): AgentMessage {
  return { role, content: text, timestamp: Date.now() };
}

function toolResult(text: string): AgentMessage {
  return {
    role: "tool-result",
    content: text,
    timestamp: Date.now(),
    toolCallId: "tc-1",
    toolName: "bash",
    isError: false,
  };
}

describe("estimateTokens", () => {
  it("returns positive for non-empty text", () => {
    expect(estimateTokens("hello world")).toBeGreaterThan(0);
    expect(estimateTokens("hello world")).toBeLessThan(10);
  });

  it("returns 0 for empty text", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

describe("compactMessages", () => {
  it("returns messages unchanged when within budget", () => {
    const messages = [msg("user", "Hello"), msg("assistant", "Hi")];
    const config: ContextConfig = {
      maxContextTokens: 100_000,
      systemPromptTokens: 4_000,
      keepRecent: 10,
      keepFirst: 2,
      toolOutputMaxLines: 50,
    };
    const result = compactMessages(messages, config);
    expect(result).toHaveLength(2);
  });

  it("truncates tool outputs in level 1", () => {
    const bigOutput = Array.from(
      { length: 200 },
      (_, i) => `line ${i + 1}`,
    ).join("\n");
    const messages = [msg("user", "do something"), toolResult(bigOutput)];
    const config: ContextConfig = {
      maxContextTokens: 200,
      systemPromptTokens: 50,
      keepRecent: 10,
      keepFirst: 2,
      toolOutputMaxLines: 20,
    };
    const result = compactMessages(messages, config);
    const content = result[1]?.content;
    expect(typeof content).toBe("string");
    expect(content as string).toContain("truncated");
  });

  it("drops middle messages when needed", () => {
    const messages = Array.from({ length: 100 }, (_, i) =>
      msg("user", `Message ${i} ${"x".repeat(200)}`),
    );
    const config: ContextConfig = {
      maxContextTokens: 500,
      systemPromptTokens: 100,
      keepRecent: 5,
      keepFirst: 2,
      toolOutputMaxLines: 20,
    };
    const result = compactMessages(messages, config);
    expect(result.length).toBeLessThan(100);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });
});

describe("ContextTracker", () => {
  it("falls back to estimation without usage data", () => {
    const tracker = new ContextTracker();
    const messages = [msg("user", "Hello"), msg("user", "World")];
    expect(tracker.estimateContextTokens(messages)).toBe(totalTokens(messages));
  });

  it("uses real usage + trailing estimation", () => {
    const tracker = new ContextTracker();
    const messages = [
      msg("user", "Hello"),
      msg("assistant", "Hi there!"),
      msg("user", "Follow up question here"),
    ];
    const usage: Usage = { input: 100, output: 50 };
    tracker.recordUsage(usage, 1);
    const tokens = tracker.estimateContextTokens(messages);
    expect(tokens).toBeGreaterThan(150);
  });

  it("resets to estimation after reset()", () => {
    const tracker = new ContextTracker();
    tracker.recordUsage({ input: 1000, output: 500 }, 5);
    tracker.reset();
    const messages = [msg("user", "test")];
    expect(tracker.estimateContextTokens(messages)).toBe(totalTokens(messages));
  });
});

describe("ExecutionTracker", () => {
  it("detects turn limit", () => {
    const limits: ExecutionLimits = {
      maxTurns: 3,
      maxTotalTokens: 1_000_000,
      maxDurationMs: 60_000,
    };
    const tracker = new ExecutionTracker(limits);
    expect(tracker.checkLimits()).toBeNull();
    tracker.recordTurn(100);
    tracker.recordTurn(100);
    expect(tracker.checkLimits()).toBeNull();
    tracker.recordTurn(100);
    expect(tracker.checkLimits()).not.toBeNull();
  });
});
