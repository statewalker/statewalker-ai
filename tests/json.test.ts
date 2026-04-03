import { describe, expect, it, vi } from "vitest";
import { jsonToTree, treeToJson } from "../src/json.js";
import { newNodeFactory } from "../src/node-factory.js";

const factory = newNodeFactory({});

function makeTree() {
  const session = factory({ type: "session" });
  const turn = session.addChild({ type: "turn", props: { turnNumber: 1 } });
  turn.addChild({ type: "user_message", content: "Hello" });
  turn.addChild({ type: "agent_message", content: "Hi there" });
  const tc = turn.addChild({
    type: "tool_call",
    props: { toolName: "read", callId: "c1" },
  });
  tc.addChild({ type: "tool_request", props: { args: { path: "/tmp" } } });
  tc.addChild({
    type: "tool_response",
    content: "file contents",
    props: { isError: false },
  });

  return { session };
}

describe("treeToJson", () => {
  it("produces nested structure", () => {
    const { session } = makeTree();
    const json = treeToJson(session);
    expect(json.props.type).toBe("session");
    expect(json.children).toHaveLength(1);
    expect(json.children?.[0]?.children).toHaveLength(3);
  });

  it("preserves content and props", () => {
    const { session } = makeTree();
    const json = treeToJson(session);
    const turn = json.children?.[0];
    expect(turn?.props.turnNumber).toBe(1);
    expect(turn?.children?.[0]?.content).toBe("Hello");
  });

  it("omits children for leaf nodes", () => {
    const { session } = makeTree();
    const json = treeToJson(session);
    expect(json.children?.[0]?.children?.[0]?.children).toBeUndefined();
  });
});

describe("jsonToTree", () => {
  it("reconstructs tree with parent refs", () => {
    const { session } = makeTree();
    const json = treeToJson(session);
    const restored = jsonToTree(json, factory);
    expect(restored.id).toBe(session.id);
    expect(restored.children).toHaveLength(1);
    expect(restored.children[0]?.parent).toBe(restored);
  });

  it("bubbleUp works on restored tree", () => {
    const { session } = makeTree();
    const restored = jsonToTree(treeToJson(session), factory);
    const listener = vi.fn();
    restored.onUpdate(listener);
    restored.children[0]?.children[0]?.bubbleUp();
    expect(listener).toHaveBeenCalled();
  });
});

describe("JSON round-trip", () => {
  it("treeToJson -> jsonToTree preserves structure", () => {
    const { session } = makeTree();
    const json = treeToJson(session);
    const restored = jsonToTree(json, factory);
    expect(treeToJson(restored)).toEqual(json);
  });
});
