import { describe, expect, it } from "vitest";
import { newNodeFactory } from "../../src/node-factory.js";
import { treeToJson } from "../../src/serialization/tree-to-json.js";

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
