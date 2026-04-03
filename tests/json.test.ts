import { SnowflakeId } from "@repo/ids";
import { describe, expect, it, vi } from "vitest";
import { jsonToTree, treeToJson } from "../src/json.js";
import { TreeEntry } from "../src/tree-entry.js";
import type { TreeNode } from "../src/types.js";

function makeTree() {
  let time = 1700000000000;
  const idGen = new SnowflakeId({ now: () => time++ });

  const session = new TreeEntry({ type: "session", idGen });
  const turn = new TreeEntry({ type: "turn", idGen, props: { turnNumber: 1 } });
  const user = new TreeEntry({ type: "user_message", idGen, content: "Hello" });
  const agent = new TreeEntry({
    type: "agent_message",
    idGen,
    content: "Hi there",
  });
  const toolCall = new TreeEntry({
    type: "tool_call",
    idGen,
    props: { toolName: "read", callId: "c1" },
  });
  const toolReq = new TreeEntry({
    type: "tool_request",
    idGen,
    props: { args: { path: "/tmp" } },
  });
  const toolResp = new TreeEntry({
    type: "tool_response",
    idGen,
    content: "file contents",
    props: { isError: false },
  });

  session.addChild(turn);
  turn.addChild(user);
  turn.addChild(agent);
  turn.addChild(toolCall);
  toolCall.addChild(toolReq);
  toolCall.addChild(toolResp);

  return { session, turn, user, agent, toolCall, toolReq, toolResp };
}

function child(
  entry: { children?: TreeNode[] | TreeEntry[] },
  index: number,
): TreeNode & { children?: TreeNode[] } {
  const c = entry.children?.[index] as TreeNode | undefined;
  if (!c) throw new Error(`No child at index ${index}`);
  return c as TreeNode & { children?: TreeNode[] };
}

describe("treeToJson", () => {
  it("produces nested TreeNode structure", () => {
    const { session } = makeTree();
    const json = treeToJson(session);

    expect(json.type).toBe("session");
    expect(json.children).toHaveLength(1);
    expect(child(json, 0).type).toBe("turn");
    expect(child(json, 0).children).toHaveLength(3);
  });

  it("preserves ids, types, props, content", () => {
    const { session, user, toolReq } = makeTree();
    const json = treeToJson(session);

    const turnJson = child(json, 0);
    expect(turnJson.props.turnNumber).toBe(1);

    const userJson = child(turnJson, 0);
    expect(userJson.id).toBe(user.id);
    expect(userJson.content).toBe("Hello");

    const toolCallJson = child(turnJson, 2);
    const toolReqJson = child(toolCallJson, 0);
    expect(toolReqJson.id).toBe(toolReq.id);
    expect(toolReqJson.props.args).toEqual({ path: "/tmp" });
  });

  it("omits children key for leaf nodes", () => {
    const { session } = makeTree();
    const json = treeToJson(session);
    const userJson = child(child(json, 0), 0);
    expect(userJson.children).toBeUndefined();
  });

  it("omits content when undefined", () => {
    const { session } = makeTree();
    const json = treeToJson(session);
    expect(json.content).toBeUndefined();
  });
});

describe("jsonToTree", () => {
  it("reconstructs tree from JSON", () => {
    const { session } = makeTree();
    const json = treeToJson(session);
    const restored = jsonToTree(json);

    expect(restored.id).toBe(session.id);
    expect(restored.type).toBe("session");
    expect(restored.children).toHaveLength(1);
    expect(child(restored, 0).children).toHaveLength(3);
  });

  it("preserves original Snowflake IDs", () => {
    const { session, user, toolResp } = makeTree();
    const json = treeToJson(session);
    const restored = jsonToTree(json);

    const turnRestored = child(restored, 0);
    expect(child(turnRestored, 0).id).toBe(user.id);

    const toolCallRestored = child(turnRestored, 2);
    expect(child(toolCallRestored, 1).id).toBe(toolResp.id);
  });

  it("wires parent references", () => {
    const { session } = makeTree();
    const json = treeToJson(session);
    const restored = jsonToTree(json);

    expect(restored.parent).toBeUndefined();
    const turn = child(restored, 0) as TreeEntry;
    expect(turn.parent).toBe(restored);
    expect(turn.parentId).toBe(restored.id);
    const u = child(turn, 0) as TreeEntry;
    expect(u.parent).toBe(turn);
  });

  it("bubbleUp works on restored tree", () => {
    const { session } = makeTree();
    const json = treeToJson(session);
    const restored = jsonToTree(json);

    const listener = vi.fn();
    restored.onUpdate(listener);

    const leaf = child(child(restored, 0), 0) as TreeEntry;
    leaf.bubbleUp();
    expect(listener).toHaveBeenCalled();
  });
});

describe("JSON round-trip", () => {
  it("treeToJson -> jsonToTree preserves structure", () => {
    const { session } = makeTree();
    const json = treeToJson(session);
    const restored = jsonToTree(json);
    const jsonAgain = treeToJson(restored);

    expect(jsonAgain).toEqual(json);
  });
});
