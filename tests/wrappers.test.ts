import { SnowflakeId } from "@repo/ids";
import { describe, expect, it, vi } from "vitest";
import { applyFlat } from "../src/apply-flat.js";
import { createEntry } from "../src/create-entry.js";
import { toFlatStream } from "../src/flat-stream.js";
import { jsonToTree, treeToJson } from "../src/json.js";
import { NodeType } from "../src/node-types.js";
import {
  createAgentNodeFactory,
  Message,
  Session,
  ToolCall,
  Turn,
} from "../src/wrappers/index.js";

const factory = createAgentNodeFactory();

function buildConversation() {
  let time = 1700000000000;
  const idGen = new SnowflakeId({ now: () => time++ });

  const rootData = createEntry({ type: NodeType.session, idGen });
  const session = new Session(rootData, factory);

  const turn1 = session.addTurn({ turnNumber: 1 });
  turn1.addUserMessage("Read /tmp/data.json");
  const agentMsg = turn1.addAgentMessage();
  agentMsg.appendDelta("Sure, let me ");
  agentMsg.appendDelta("read that file.");
  const thinking = agentMsg.addThinkingBlock();
  thinking.appendDelta("I should use the read tool");

  const toolCall = turn1.addToolCall("call-001", "read_file", {
    path: "/tmp/data.json",
  });
  toolCall.addResponse('{"name": "test", "value": 42}');

  turn1.stopReason = "tool-use";
  turn1.model = "claude-sonnet-4-20250514";
  turn1.usage = { input: 100, output: 50, cacheRead: 10 };

  const turn2 = session.addTurn({ turnNumber: 2 });
  const agentMsg2 = turn2.addAgentMessage();
  agentMsg2.appendDelta("The file contains a JSON object.");
  turn2.stopReason = "stop";

  return {
    session,
    turn1,
    turn2,
    agentMsg,
    thinking,
    toolCall,
    agentMsg2,
    idGen,
  };
}

describe("Session", () => {
  it("lists turns", () => {
    const { session } = buildConversation();
    expect(session.turns).toHaveLength(2);
    expect(session.turns[0]).toBeInstanceOf(Turn);
  });

  it("gets currentTurn", () => {
    const { session } = buildConversation();
    expect(session.currentTurn?.turnNumber).toBe(2);
  });

  it("addTurn creates typed Turn child", () => {
    const { session } = buildConversation();
    const t3 = session.addTurn({ turnNumber: 3 });
    expect(t3).toBeInstanceOf(Turn);
    expect(session.turns).toHaveLength(3);
  });

  it("addTurn notifies session", () => {
    const { session } = buildConversation();
    const listener = vi.fn();
    session.onUpdate(listener);
    session.addTurn({ turnNumber: 3 });
    expect(listener).toHaveBeenCalled();
  });
});

describe("Turn", () => {
  it("accesses turn metadata", () => {
    const { turn1 } = buildConversation();
    expect(turn1.turnNumber).toBe(1);
    expect(turn1.stopReason).toBe("tool-use");
    expect(turn1.model).toBe("claude-sonnet-4-20250514");
    expect(turn1.usage?.input).toBe(100);
  });

  it("lists messages (not tool calls)", () => {
    const { turn1 } = buildConversation();
    expect(turn1.messages).toHaveLength(2);
    expect(turn1.messages[0]?.role).toBe("user");
    expect(turn1.messages[1]?.role).toBe("assistant");
  });

  it("lists tool calls", () => {
    const { turn1 } = buildConversation();
    expect(turn1.toolCalls).toHaveLength(1);
    expect(turn1.toolCalls[0]?.toolName).toBe("read_file");
  });

  it("addToolCall creates typed ToolCall with request", () => {
    const { turn2 } = buildConversation();
    const tc = turn2.addToolCall("c2", "write", { data: "hi" });
    expect(tc).toBeInstanceOf(ToolCall);
    expect(tc.args).toEqual({ data: "hi" });
    expect(tc.request).toBeDefined();
  });
});

describe("Message", () => {
  it("maps type to role", () => {
    const { turn1 } = buildConversation();
    const msgs = turn1.messages;
    expect(msgs[0]?.role).toBe("user");
    expect(msgs[1]?.role).toBe("assistant");
  });

  it("appendDelta accumulates text", () => {
    const { agentMsg } = buildConversation();
    expect(agentMsg.text).toBe("Sure, let me read that file.");
  });

  it("appendDelta fires touch + bubbleUp", () => {
    const { session, agentMsg2 } = buildConversation();
    const listener = vi.fn();
    session.onUpdate(listener);
    agentMsg2.appendDelta(" Extra.");
    expect(listener).toHaveBeenCalled();
    expect(agentMsg2.props.updatedAt).toBeDefined();
  });

  it("thinking blocks", () => {
    const { agentMsg } = buildConversation();
    expect(agentMsg.thinkingBlocks).toHaveLength(1);
    expect(agentMsg.thinkingBlocks[0]?.text).toBe("I should use the read tool");
  });
});

describe("ToolCall", () => {
  it("accesses metadata", () => {
    const { toolCall } = buildConversation();
    expect(toolCall.callId).toBe("call-001");
    expect(toolCall.toolName).toBe("read_file");
    expect(toolCall.args).toEqual({ path: "/tmp/data.json" });
  });

  it("accesses response", () => {
    const { toolCall } = buildConversation();
    expect(toolCall.result).toBe('{"name": "test", "value": 42}');
    expect(toolCall.isError).toBe(false);
  });

  it("addResponse + appendUpdate", () => {
    const { turn2 } = buildConversation();
    const tc = turn2.addToolCall("c2", "read");
    tc.addResponse("partial...");
    tc.appendUpdate("partial... done!");
    expect(tc.result).toBe("partial... done!");
  });
});

describe("JSON round-trip", () => {
  it("preserves full conversation", () => {
    const { session } = buildConversation();
    const json = treeToJson(session);
    const restored = jsonToTree(json, factory) as Session;

    expect(restored).toBeInstanceOf(Session);
    expect(restored.turns).toHaveLength(2);

    const t1 = restored.turns[0] as Turn;
    expect(t1).toBeInstanceOf(Turn);
    expect(t1.turnNumber).toBe(1);
    expect(t1.messages).toHaveLength(2);
    expect(t1.messages[0]?.role).toBe("user");
    expect(t1.messages[0]?.text).toBe("Read /tmp/data.json");
    expect(t1.messages[1]?.text).toBe("Sure, let me read that file.");

    expect(t1.toolCalls).toHaveLength(1);
    expect(t1.toolCalls[0]).toBeInstanceOf(ToolCall);
    expect(t1.toolCalls[0]?.args).toEqual({ path: "/tmp/data.json" });
    expect(t1.toolCalls[0]?.result).toBe('{"name": "test", "value": 42}');
  });
});

describe("Flat stream round-trip", () => {
  it("preserves conversation via toFlatStream → applyFlat", () => {
    const { session } = buildConversation();
    const clone = applyFlat(
      undefined,
      toFlatStream(session),
      factory,
    ) as Session;

    expect(clone).toBeInstanceOf(Session);
    expect(clone.turns).toHaveLength(2);
    expect(clone.turns[0]?.messages[0]?.text).toBe("Read /tmp/data.json");
  });

  it("incremental sync", () => {
    const { session, idGen } = buildConversation();
    const clone = applyFlat(
      undefined,
      toFlatStream(session),
      factory,
    ) as Session;

    const sinceId = idGen.generate();
    session.addTurn({ turnNumber: 3 }).addUserMessage("More?");

    applyFlat(clone, toFlatStream(session, sinceId), factory);
    expect(clone.turns).toHaveLength(3);
    expect(clone.turns[2]?.messages[0]?.text).toBe("More?");
  });
});

describe("Children caching", () => {
  it("returns same wrapper instance on repeated access", () => {
    const { session } = buildConversation();
    const t1a = session.turns[0];
    const t1b = session.turns[0];
    expect(t1a).toBe(t1b);
  });

  it("typed wrappers from factory", () => {
    const { session } = buildConversation();
    expect(session.turns[0]).toBeInstanceOf(Turn);
    expect(session.turns[0]?.messages[0]).toBeInstanceOf(Message);
    expect(session.turns[0]?.toolCalls[0]).toBeInstanceOf(ToolCall);
  });
});
