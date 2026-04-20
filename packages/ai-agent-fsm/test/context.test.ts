import { describe, expect, it } from "vitest";
import {
  AgentContext,
  buildSystemPrompt,
  estimateTokens,
  maskOldToolOutputs,
  toModelMessages,
} from "../src/context.js";
import type { AgentMessage, Skill } from "../src/types.js";

// ── estimateTokens ──────────────────────────────────────────

describe("estimateTokens", () => {
  it("returns 0 for an empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it('returns 1 for "hello" (5 chars / 4 ≈ 1)', () => {
    expect(estimateTokens("hello")).toBe(Math.round(5 / 4));
  });

  it("returns 25 for a 100-character string", () => {
    const text = "a".repeat(100);
    expect(estimateTokens(text)).toBe(25);
  });
});

// ── buildSystemPrompt ───────────────────────────────────────

describe("buildSystemPrompt", () => {
  it("returns the base string when there are no skills", () => {
    expect(buildSystemPrompt("You are a helpful assistant.", [])).toBe(
      "You are a helpful assistant.",
    );
  });

  it("includes XML skill blocks when skills are provided", () => {
    const skills: Skill[] = [
      { name: "search", description: "web search", content: "Use the web." },
    ];
    const result = buildSystemPrompt("Base prompt.", skills);
    expect(result).toContain("Base prompt.");
    expect(result).toContain('<skill name="search">');
    expect(result).toContain("Use the web.");
    expect(result).toContain("</skill>");
  });

  it("returns only skill blocks when base is undefined", () => {
    const skills: Skill[] = [
      { name: "code", description: "coding", content: "Write code." },
    ];
    const result = buildSystemPrompt(undefined, skills);
    expect(result).not.toContain("undefined");
    expect(result).toContain('<skill name="code">');
    expect(result).toContain("Write code.");
  });
});

// ── toModelMessages ─────────────────────────────────────────

describe("toModelMessages", () => {
  it("converts a user message", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "Hi there", timestamp: 1 },
    ];
    const result = toModelMessages(messages);
    expect(result).toEqual([{ role: "user", content: "Hi there" }]);
  });

  it("converts an assistant message with text", () => {
    const messages: AgentMessage[] = [
      { role: "assistant", content: "Hello!", timestamp: 1 },
    ];
    const result = toModelMessages(messages);
    expect(result).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "Hello!" }],
      },
    ]);
  });

  it("converts an assistant message with tool calls", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { toolCallId: "tc1", toolName: "search", args: { q: "test" } },
        ],
        timestamp: 1,
      },
    ];
    const result = toModelMessages(messages);
    expect(result).toHaveLength(1);
    const msg = result[0]!;
    expect(msg.role).toBe("assistant");
    if (msg.role === "assistant") {
      expect(msg.content).toContainEqual({
        type: "tool-call",
        toolCallId: "tc1",
        toolName: "search",
        args: { q: "test" },
      });
    }
  });

  it("converts a tool result message", () => {
    const messages: AgentMessage[] = [
      {
        role: "tool",
        content: "search: some result",
        toolResults: [
          {
            toolCallId: "tc1",
            toolName: "search",
            output: "some result",
          },
        ],
        timestamp: 1,
      },
    ];
    const result = toModelMessages(messages);
    expect(result).toEqual([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc1",
            toolName: "search",
            result: "some result",
            isError: undefined,
          },
        ],
      },
    ]);
  });
});

// ── maskOldToolOutputs ──────────────────────────────────────

describe("maskOldToolOutputs", () => {
  const baseMessages: AgentMessage[] = [
    { role: "user", content: "First question", timestamp: 1 },
    {
      role: "tool",
      content: "tool: first output",
      toolResults: [
        { toolCallId: "t1", toolName: "tool", output: "first output" },
      ],
      timestamp: 2,
    },
    { role: "user", content: "Second question", timestamp: 3 },
    {
      role: "tool",
      content: "tool: second output",
      toolResults: [
        { toolCallId: "t2", toolName: "tool", output: "second output" },
      ],
      timestamp: 4,
    },
  ];

  it("masks the first tool output when protectLastNTurns=1", () => {
    const result = maskOldToolOutputs(baseMessages, 1);
    // First tool result (before the protected turn) should be masked
    expect(result[1]?.content).toBe("[Tool output cleared]");
    expect(result[1]?.toolResults?.[0]?.output).toBe("[Tool output cleared]");
    // Second tool result (within the last 1 user turn) should be preserved
    expect(result[3]?.content).toBe("tool: second output");
    expect(result[3]?.toolResults?.[0]?.output).toBe("second output");
  });

  it("preserves both tool outputs when protectLastNTurns=2", () => {
    const result = maskOldToolOutputs(baseMessages, 2);
    expect(result[1]?.toolResults?.[0]?.output).toBe("first output");
    expect(result[3]?.toolResults?.[0]?.output).toBe("second output");
  });

  it("never masks non-tool messages", () => {
    const result = maskOldToolOutputs(baseMessages, 1);
    expect(result[0]?.content).toBe("First question");
    expect(result[2]?.content).toBe("Second question");
  });
});

// ── AgentContext ─────────────────────────────────────────────

describe("AgentContext", () => {
  it("addUserMessage adds a message with role 'user' and a timestamp", () => {
    const ctx = new AgentContext();
    const before = Date.now();
    ctx.addUserMessage("Hello");
    const after = Date.now();

    expect(ctx.messages).toHaveLength(1);
    const msg = ctx.messages[0]!;
    expect(msg.role).toBe("user");
    expect(msg.content).toBe("Hello");
    expect(msg.timestamp).toBeGreaterThanOrEqual(before);
    expect(msg.timestamp).toBeLessThanOrEqual(after);
  });

  it("addAssistantMessage stores usage and updates totalTokens", () => {
    const ctx = new AgentContext();
    const usage = { inputTokens: 10, outputTokens: 20, totalTokens: 30 };
    ctx.addAssistantMessage("Sure!", undefined, usage);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0]?.role).toBe("assistant");
    expect(ctx.messages[0]?.content).toBe("Sure!");
    expect(ctx.messages[0]?.usage).toEqual(usage);
    expect(ctx.totalTokens).toBe(30);
  });

  it("addToolResultMessage builds content from results", () => {
    const ctx = new AgentContext();
    const results = [
      { toolCallId: "tc1", toolName: "echo", output: "hello" },
      { toolCallId: "tc2", toolName: "calc", output: "42" },
    ];
    ctx.addToolResultMessage(results);

    expect(ctx.messages).toHaveLength(1);
    const msg = ctx.messages[0]!;
    expect(msg.role).toBe("tool");
    expect(msg.content).toBe("echo: hello\ncalc: 42");
    expect(msg.toolResults).toEqual(results);
  });

  it("getModelMessages returns proper format", () => {
    const ctx = new AgentContext();
    ctx.addUserMessage("Hi");
    ctx.addAssistantMessage("Hello!");

    const model = ctx.getModelMessages();
    expect(model).toHaveLength(2);
    expect(model[0]!).toEqual({ role: "user", content: "Hi" });
    expect(model[1]!).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Hello!" }],
    });
  });

  it("getModelMessages with maskAfterTurns masks old outputs", () => {
    const ctx = new AgentContext();
    ctx.addUserMessage("First");
    ctx.addAssistantMessage("", [
      { toolCallId: "tc1", toolName: "echo", args: { text: "a" } },
    ]);
    ctx.addToolResultMessage([
      { toolCallId: "tc1", toolName: "echo", output: "a" },
    ]);
    ctx.addUserMessage("Second");
    ctx.addAssistantMessage("Done");

    const model = ctx.getModelMessages(1);
    // The tool result (index 2) is before the last user turn, so it should be masked
    const toolMsg = model[2]!;
    expect(toolMsg.role).toBe("tool");
    if (toolMsg.role === "tool") {
      expect(toolMsg.content[0]?.result).toBe("[Tool output cleared]");
    }
  });
});
