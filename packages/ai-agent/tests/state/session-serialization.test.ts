import { describe, expect, it } from "vitest";
import {
  createAgentNodeFactory,
  Message,
  NodeType,
  SessionState,
  ToolCall,
  Turn,
} from "../../src/state/index.js";
import { jsonToTree, treeToJson } from "../../src/state/serialization/index.js";
import { markdownToSession, sessionToMarkdown } from "../../src/state/session-serialization.js";

const factory = createAgentNodeFactory();

/** Build a realistic session with object props for round-trip testing. */
function buildSession(): SessionState {
  const session = factory<SessionState>({ type: NodeType.session });

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

describe("SessionState serialization — JSON round-trip", () => {
  it("preserves tree structure and typed nodes", () => {
    const session = buildSession();
    const json = treeToJson(session);
    const restored = jsonToTree(json, factory) as SessionState;

    expect(restored).toBeInstanceOf(SessionState);
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
    const restored = jsonToTree(json, factory) as SessionState;

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

describe("SessionState serialization — Markdown round-trip", () => {
  it("preserves tree structure and typed nodes", async () => {
    const session = buildSession();
    const md = await sessionToMarkdown(session);
    const restored = (await markdownToSession(md, factory)) as SessionState;

    expect(restored).toBeInstanceOf(SessionState);
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

  it("preserves object props through markdown headers", async () => {
    const session = buildSession();
    const md = await sessionToMarkdown(session);
    const restored = (await markdownToSession(md, factory)) as SessionState;

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

  it("Markdown round-trip produces identical JSON snapshot", async () => {
    const session = buildSession();
    const md = await sessionToMarkdown(session);
    const restored = await markdownToSession(md, factory);
    expect(treeToJson(restored)).toEqual(treeToJson(session));
  });
});
