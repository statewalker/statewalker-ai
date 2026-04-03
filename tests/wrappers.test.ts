import { SnowflakeId } from "@repo/ids";
import { describe, expect, it, vi } from "vitest";
import { applyFlat } from "../src/apply-flat.js";
import { toFlatStream } from "../src/flat-stream.js";
import { jsonToTree, treeToJson } from "../src/json.js";
import { TreeEntry } from "../src/tree-entry.js";
import {
  MessageView,
  NodeType,
  SessionView,
  TreeNodeWrapper,
  TurnView,
} from "../src/wrappers.js";

// ─── Helper: build a realistic agent conversation ───────────────

function buildConversation() {
  let time = 1700000000000;
  const idGen = new SnowflakeId({ now: () => time++ });

  const root = new TreeEntry({ type: NodeType.session, idGen });
  const session = new SessionView(root);

  // Turn 1: user asks, agent responds with text + tool call
  const turn1 = session.addTurn({ turnNumber: 1 });
  const userMsg = turn1.addUserMessage("Read /tmp/data.json");
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

  // Turn 2: agent summarizes
  const turn2 = session.addTurn({ turnNumber: 2 });
  const agentMsg2 = turn2.addAgentMessage();
  agentMsg2.appendDelta("The file contains a JSON object with name 'test'.");
  turn2.stopReason = "stop";
  turn2.model = "claude-sonnet-4-20250514";

  return {
    root,
    session,
    turn1,
    turn2,
    userMsg,
    agentMsg,
    thinking,
    toolCall,
    agentMsg2,
    idGen,
  };
}

// ─── TreeNodeWrapper base ───────────────────────────────────────

describe("TreeNodeWrapper", () => {
  it("delegates id, type, props, content to entry", () => {
    const entry = new TreeEntry({
      type: "test",
      props: { key: "val" },
      content: "hello",
    });
    const wrapper = new TreeNodeWrapper(entry);
    expect(wrapper.id).toBe(entry.id);
    expect(wrapper.type).toBe("test");
    expect(wrapper.props.key).toBe("val");
    expect(wrapper.content).toBe("hello");
  });

  it("has its own onUpdate/notify", () => {
    const entry = new TreeEntry({ type: "test" });
    const wrapper = new TreeNodeWrapper(entry);
    const listener = vi.fn();
    wrapper.onUpdate(listener);
    wrapper.notify();
    expect(listener).toHaveBeenCalledOnce();
  });
});

// ─── SessionView ────────────────────────────────────────────────

describe("SessionView", () => {
  it("lists turns", () => {
    const { session } = buildConversation();
    expect(session.turns).toHaveLength(2);
    expect(session.turns[0]).toBeInstanceOf(TurnView);
  });

  it("gets currentTurn", () => {
    const { session, turn2 } = buildConversation();
    expect(session.currentTurn?.turnNumber).toBe(2);
    expect(session.currentTurn?.id).toBe(turn2.id);
  });

  it("addTurn creates a new turn", () => {
    const { session } = buildConversation();
    const turn3 = session.addTurn({ turnNumber: 3 });
    expect(session.turns).toHaveLength(3);
    expect(turn3.turnNumber).toBe(3);
  });

  it("addTurn notifies session listeners", () => {
    const { session } = buildConversation();
    const listener = vi.fn();
    session.onUpdate(listener);
    session.addTurn({ turnNumber: 3 });
    expect(listener).toHaveBeenCalled();
  });
});

// ─── TurnView ───────────────────────────────────────────────────

describe("TurnView", () => {
  it("accesses turn metadata", () => {
    const { turn1 } = buildConversation();
    expect(turn1.turnNumber).toBe(1);
    expect(turn1.stopReason).toBe("tool-use");
    expect(turn1.model).toBe("claude-sonnet-4-20250514");
    expect(turn1.usage?.input).toBe(100);
    expect(turn1.usage?.output).toBe(50);
    expect(turn1.usage?.cacheRead).toBe(10);
  });

  it("lists messages (user + agent, not tool calls)", () => {
    const { turn1 } = buildConversation();
    const msgs = turn1.messages;
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.role).toBe("user");
    expect(msgs[1]?.role).toBe("assistant");
  });

  it("lists tool calls", () => {
    const { turn1 } = buildConversation();
    const tcs = turn1.toolCalls;
    expect(tcs).toHaveLength(1);
    expect(tcs[0]?.toolName).toBe("read_file");
    expect(tcs[0]?.callId).toBe("call-001");
  });

  it("addUserMessage creates user message", () => {
    const { turn1 } = buildConversation();
    const msg = turn1.addUserMessage("Another message");
    expect(msg.role).toBe("user");
    expect(msg.text).toBe("Another message");
  });

  it("addAgentMessage creates empty agent message", () => {
    const { turn2 } = buildConversation();
    const msg = turn2.addAgentMessage();
    expect(msg.role).toBe("assistant");
    expect(msg.text).toBe("");
  });

  it("addToolCall creates tool call with request child", () => {
    const { turn2 } = buildConversation();
    const tc = turn2.addToolCall("call-002", "write_file", {
      path: "/tmp/out.txt",
      data: "hello",
    });
    expect(tc.callId).toBe("call-002");
    expect(tc.toolName).toBe("write_file");
    expect(tc.args).toEqual({ path: "/tmp/out.txt", data: "hello" });
    expect(tc.request).toBeDefined();
    expect(tc.response).toBeUndefined();
  });
});

// ─── MessageView ────────────────────────────────────────────────

describe("MessageView", () => {
  it("maps type to role", () => {
    const { userMsg, agentMsg, thinking } = buildConversation();
    expect(userMsg.role).toBe("user");
    expect(agentMsg.role).toBe("assistant");
    expect(thinking.role).toBe("thinking");
  });

  it("appendDelta accumulates text", () => {
    const { agentMsg } = buildConversation();
    expect(agentMsg.text).toBe("Sure, let me read that file.");
  });

  it("appendDelta calls touch + notify", () => {
    const msg = new MessageView(
      new TreeEntry({ type: NodeType.agentMessage, content: "" }),
    );
    const wrapperListener = vi.fn();
    const entryListener = vi.fn();
    msg.onUpdate(wrapperListener);
    msg.entry.onUpdate(entryListener);

    msg.appendDelta("hello");
    expect(wrapperListener).toHaveBeenCalled();
    expect(entryListener).toHaveBeenCalled();
    expect(msg.entry.props.updatedAt).toBeDefined();
  });

  it("appendDelta bubbles up to session", () => {
    const { root, agentMsg2 } = buildConversation();
    const rootListener = vi.fn();
    root.onUpdate(rootListener);
    agentMsg2.appendDelta(" Extra text.");
    expect(rootListener).toHaveBeenCalled();
  });

  it("lists thinking blocks", () => {
    const { agentMsg } = buildConversation();
    const blocks = agentMsg.thinkingBlocks;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe("I should use the read tool");
  });

  it("addThinkingBlock creates child", () => {
    const msg = new MessageView(
      new TreeEntry({ type: NodeType.agentMessage, content: "hi" }),
    );
    const block = msg.addThinkingBlock();
    block.appendDelta("reasoning...");
    expect(msg.thinkingBlocks).toHaveLength(1);
    expect(msg.thinkingBlocks[0]?.text).toBe("reasoning...");
  });
});

// ─── ToolCallView ───────────────────────────────────────────────

describe("ToolCallView", () => {
  it("accesses call metadata", () => {
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

  it("addResponse creates response child", () => {
    const turn = new TurnView(new TreeEntry({ type: NodeType.turn }));
    const tc = turn.addToolCall("c1", "my_tool", { x: 1 });
    expect(tc.response).toBeUndefined();

    tc.addResponse("done", false);
    expect(tc.result).toBe("done");
    expect(tc.isError).toBe(false);
  });

  it("addResponse with error", () => {
    const turn = new TurnView(new TreeEntry({ type: NodeType.turn }));
    const tc = turn.addToolCall("c1", "my_tool");
    tc.addResponse("failed", true);
    expect(tc.isError).toBe(true);
    expect(tc.result).toBe("failed");
  });

  it("appendUpdate modifies response content", () => {
    const turn = new TurnView(new TreeEntry({ type: NodeType.turn }));
    const tc = turn.addToolCall("c1", "my_tool");
    tc.addResponse("partial...");
    tc.appendUpdate("partial... complete!");
    expect(tc.result).toBe("partial... complete!");
  });

  it("progressText gets/sets", () => {
    const turn = new TurnView(new TreeEntry({ type: NodeType.turn }));
    const tc = turn.addToolCall("c1", "my_tool");
    expect(tc.progressText).toBeUndefined();
    tc.progressText = "Reading file...";
    expect(tc.progressText).toBe("Reading file...");
  });
});

// ─── Full conversation: JSON round-trip ─────────────────────────

describe("JSON round-trip with wrappers", () => {
  it("serializes and restores a full conversation", () => {
    const { root } = buildConversation();
    const json = treeToJson(root);
    const restored = jsonToTree(json);

    const session = new SessionView(restored);
    expect(session.turns).toHaveLength(2);

    const t1 = session.turns[0];
    expect(t1).toBeDefined();
    expect(t1?.turnNumber).toBe(1);
    expect(t1?.stopReason).toBe("tool-use");
    expect(t1?.model).toBe("claude-sonnet-4-20250514");
    expect(t1?.usage?.input).toBe(100);

    const msgs = t1?.messages ?? [];
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.role).toBe("user");
    expect(msgs[0]?.text).toBe("Read /tmp/data.json");
    expect(msgs[1]?.role).toBe("assistant");
    expect(msgs[1]?.text).toBe("Sure, let me read that file.");

    const thinkingBlocks = msgs[1]?.thinkingBlocks ?? [];
    expect(thinkingBlocks).toHaveLength(1);
    expect(thinkingBlocks[0]?.text).toBe("I should use the read tool");

    const tcs = t1?.toolCalls ?? [];
    expect(tcs).toHaveLength(1);
    expect(tcs[0]?.toolName).toBe("read_file");
    expect(tcs[0]?.callId).toBe("call-001");
    expect(tcs[0]?.args).toEqual({ path: "/tmp/data.json" });
    expect(tcs[0]?.result).toBe('{"name": "test", "value": 42}');
    expect(tcs[0]?.isError).toBe(false);

    const t2 = session.turns[1];
    expect(t2?.turnNumber).toBe(2);
    expect(t2?.stopReason).toBe("stop");
    const msgs2 = t2?.messages ?? [];
    expect(msgs2[0]?.text).toBe(
      "The file contains a JSON object with name 'test'.",
    );
  });
});

// ─── Full conversation: flat stream round-trip ──────────────────

describe("Flat stream round-trip with wrappers", () => {
  it("toFlatStream → applyFlat preserves conversation structure", () => {
    const { root } = buildConversation();
    const clone = applyFlat(undefined, toFlatStream(root));

    const session = new SessionView(clone);
    expect(session.turns).toHaveLength(2);

    const t1 = session.turns[0];
    expect(t1?.messages).toHaveLength(2);
    expect(t1?.toolCalls).toHaveLength(1);
    expect(t1?.toolCalls[0]?.result).toBe('{"name": "test", "value": 42}');
  });

  it("incremental sync preserves new turns", () => {
    const { root, session, idGen } = buildConversation();
    const clone = applyFlat(undefined, toFlatStream(root));

    const sinceId = idGen.generate();

    // Add turn 3 to original
    const turn3 = session.addTurn({ turnNumber: 3 });
    turn3.addUserMessage("What else is there?");

    applyFlat(clone, toFlatStream(root, sinceId));

    const cloneSession = new SessionView(clone);
    expect(cloneSession.turns).toHaveLength(3);
    expect(cloneSession.turns[2]?.turnNumber).toBe(3);
    expect(cloneSession.turns[2]?.messages[0]?.text).toBe(
      "What else is there?",
    );
  });
});

// ─── Wrapper + raw entry coexistence ────────────────────────────

describe("Wrapper-raw coexistence", () => {
  it("mutation via wrapper is visible on raw entry", () => {
    const entry = new TreeEntry({
      type: NodeType.agentMessage,
      content: "Hello",
    });
    const view = new MessageView(entry);
    view.appendDelta(" world");
    expect(entry.content).toBe("Hello world");
  });

  it("mutation on raw entry is visible via wrapper", () => {
    const entry = new TreeEntry({
      type: NodeType.agentMessage,
      content: "Hello",
    });
    const view = new MessageView(entry);
    entry.content = "Changed";
    expect(view.text).toBe("Changed");
  });
});
