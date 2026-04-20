import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  jsonToTree,
  markdownToTree,
  treeToJson,
  treeToMarkdown,
} from "@statewalker/ai-agent-state";
import { describe, expect, it } from "vitest";
import {
  createAgentNodeFactory,
  Message,
  NodeType,
  Session,
  sessionToMarkdown,
  ToolCall,
  Turn,
} from "../../src/state/index.js";

const factory = createAgentNodeFactory();

/** Build a realistic session with object props for round-trip testing. */
function buildSession(): Session {
  const session = factory<Session>({ type: NodeType.session });

  const turn = session.addTurn({ turnNumber: 1 });
  turn.addUserMessage("What time is it?");

  // Agent message with thinking block and providerMetadata
  const agentMsg = turn.addAgentMessage();
  const thinking = agentMsg.addThinkingBlock();
  thinking.appendDelta("I need to check the time.");
  thinking.props.providerMetadata = {
    google: { thoughtSignature: "sig123" },
  };
  agentMsg.appendDelta("Let me check the time for you.");
  agentMsg.props.providerMetadata = {
    google: { thoughtSignature: "sig456" },
  };

  // Tool call with object args and request content
  const tc = turn.addToolCall("call-001", "get_current_time", {
    timezone: "UTC",
    format: "iso",
  });
  const req = tc.request;
  if (req) req.content = JSON.stringify({ timezone: "UTC", format: "iso" });
  tc.props.providerMetadata = { google: { thoughtSignature: "sig789" } };
  tc.addResponse(
    JSON.stringify({
      time: "Monday, April 6, 2026",
      iso: "2026-04-06T13:20:00Z",
    }),
  );

  // Set turn metadata with object props
  turn.model = "gemini-flash-latest";
  turn.stopReason = "stop";
  turn.usage = { input: 150, output: 80, cacheRead: 20 };

  return session;
}

describe("Session serialization — JSON round-trip", () => {
  it("preserves tree structure and typed nodes", () => {
    const session = buildSession();
    const json = treeToJson(session);
    const restored = jsonToTree(json, factory) as Session;

    expect(restored).toBeInstanceOf(Session);
    expect(restored.turns).toHaveLength(1);

    const turn = restored.turns[0] as Turn;
    expect(turn).toBeInstanceOf(Turn);
    expect(turn.turnNumber).toBe(1);
    expect(turn.model).toBe("gemini-flash-latest");
    expect(turn.stopReason).toBe("stop");

    expect(turn.messages).toHaveLength(2);
    expect(turn.messages[0]).toBeInstanceOf(Message);
    expect(turn.messages[0]?.text).toBe("What time is it?");
    expect(turn.messages[1]?.text).toBe("Let me check the time for you.");

    expect(turn.toolCalls).toHaveLength(1);
    const tc = turn.toolCalls[0] as ToolCall;
    expect(tc).toBeInstanceOf(ToolCall);
    expect(tc.callId).toBe("call-001");
    expect(tc.toolName).toBe("get_current_time");
  });

  it("preserves object props (usage, providerMetadata, args)", () => {
    const session = buildSession();
    const json = treeToJson(session);
    const restored = jsonToTree(json, factory) as Session;

    const turn = restored.turns[0] as Turn;
    expect(turn.usage).toEqual({ input: 150, output: 80, cacheRead: 20 });

    const agentMsg = turn.messages[1] as Message;
    expect(agentMsg.props.providerMetadata).toEqual({
      google: { thoughtSignature: "sig456" },
    });

    const thinking = agentMsg.thinkingBlocks[0] as Message;
    expect(thinking.props.providerMetadata).toEqual({
      google: { thoughtSignature: "sig123" },
    });

    const tc = turn.toolCalls[0] as ToolCall;
    expect(tc.args).toEqual({ timezone: "UTC", format: "iso" });
    expect(tc.props.providerMetadata).toEqual({
      google: { thoughtSignature: "sig789" },
    });
  });

  it("JSON snapshots are identical", () => {
    const session = buildSession();
    const json = treeToJson(session);
    const restored = jsonToTree(json, factory);
    expect(treeToJson(restored)).toEqual(json);
  });
});

describe("Session serialization — Markdown round-trip", () => {
  it("preserves tree structure and typed nodes", () => {
    const session = buildSession();
    const md = sessionToMarkdown(session);
    const restored = markdownToTree(md, factory) as Session;

    expect(restored).toBeInstanceOf(Session);
    expect(restored.turns).toHaveLength(1);

    const turn = restored.turns[0] as Turn;
    expect(turn).toBeInstanceOf(Turn);
    expect(turn.turnNumber).toBe(1);
    expect(turn.model).toBe("gemini-flash-latest");
    expect(turn.stopReason).toBe("stop");

    expect(turn.messages).toHaveLength(2);
    expect(turn.messages[0]?.text).toBe("What time is it?");
    expect(turn.messages[1]?.text).toBe("Let me check the time for you.");

    const tc = turn.toolCalls[0] as ToolCall;
    expect(tc.callId).toBe("call-001");
    expect(tc.toolName).toBe("get_current_time");
  });

  it("preserves object props through markdown headers", () => {
    const session = buildSession();
    const md = sessionToMarkdown(session);
    const restored = markdownToTree(md, factory) as Session;

    const turn = restored.turns[0] as Turn;

    // usage is an object — must survive JSON.stringify → tryParseJson roundtrip
    expect(turn.usage).toEqual({ input: 150, output: 80, cacheRead: 20 });

    // providerMetadata is a nested object
    const agentMsg = turn.messages[1] as Message;
    expect(agentMsg.props.providerMetadata).toEqual({
      google: { thoughtSignature: "sig456" },
    });

    // args is an object on tool_request
    const tc = turn.toolCalls[0] as ToolCall;
    expect(tc.args).toEqual({ timezone: "UTC", format: "iso" });
  });

  it("wraps tool content in fenced code blocks", () => {
    const session = buildSession();
    const md = sessionToMarkdown(session);

    expect(md).toContain("```llm:tool-params\n");
    expect(md).toContain("```llm:tool-response\n");

    // Content is still correctly round-tripped
    const restored = markdownToTree(md, factory) as Session;
    const tc = restored.turns[0]?.toolCalls[0] as ToolCall;
    expect(tc.request?.content).toContain("timezone");
    expect(tc.result).toContain("Monday, April 6, 2026");
  });

  it("Markdown round-trip produces identical JSON snapshot", () => {
    const session = buildSession();
    const md = sessionToMarkdown(session);
    const restored = markdownToTree(md, factory);
    expect(treeToJson(restored)).toEqual(treeToJson(session));
  });

  it("plain treeToMarkdown still works without code blocks", () => {
    const session = buildSession();
    const md = treeToMarkdown(session);
    expect(md).not.toContain("```llm:");

    // Still round-trips correctly
    const restored = markdownToTree(md, factory);
    expect(treeToJson(restored)).toEqual(treeToJson(session));
  });

  it("round-trips the test-session.md fixture", () => {
    const fixturePath = resolve(
      import.meta.dirname,
      "fixtures/test-session.md",
    );
    const markdown = readFileSync(fixturePath, "utf-8");
    const session = markdownToTree(markdown, factory) as Session;

    expect(session).toBeInstanceOf(Session);
    expect(session.turns).toHaveLength(1);

    const turn = session.turns[0] as Turn;
    expect(turn).toBeInstanceOf(Turn);
    expect(turn.model).toBe("gemini-flash-latest");
    expect(turn.stopReason).toBe("stop");

    // User message
    expect(turn.messages[0]?.text).toBe("What time is it?");

    // Tool call with object providerMetadata
    const tc = turn.toolCalls[0] as ToolCall;
    expect(tc.callId).toBe("JyeyJ1LYnuX950UV");
    expect(tc.toolName).toBe("get_current_time");
    expect(tc.props.providerMetadata).toEqual({
      google: {
        thoughtSignature: "dGVzdC10aG91Z2h0LXNpZ25hdHVyZS1mb3ItdG9vbC1jYWxs",
      },
    });

    // Tool request args — code fence stripped
    expect(tc.args).toEqual({});
    expect(tc.request?.content).toBe("{}");

    // Tool response — code fence stripped
    expect(tc.result).toContain("Monday, April 6, 2026");
    expect(tc.isError).toBe(false);

    // Agent message
    const agentMsg = turn.messages[1] as Message;
    expect(agentMsg.text).toContain("1:20 PM UTC");

    // Re-serialize with sessionToMarkdown and compare
    const md2 = sessionToMarkdown(session);
    const session2 = markdownToTree(md2, factory) as Session;
    expect(treeToJson(session2)).toEqual(treeToJson(session));
  });
});
