import { SnowflakeId } from "@repo/ids";
import { describe, expect, it, vi } from "vitest";
import { createEntry } from "../src/create-entry.js";
import { jsonToTree, treeToJson } from "../src/json.js";
import { TreeNode } from "../src/tree-node.js";
import type { NodeFactory } from "../src/types.js";

const defaultFactory: NodeFactory = (data) => new TreeNode(data);

function makeTree() {
  let time = 1700000000000;
  const idGen = new SnowflakeId({ now: () => time++ });

  const session = new TreeNode(
    createEntry({ type: "session", idGen }),
    defaultFactory,
  );
  const turn = session.addChild(
    createEntry({ type: "turn", idGen, props: { turnNumber: 1 } }),
  );
  turn.addChild(createEntry({ type: "user_message", idGen, content: "Hello" }));
  turn.addChild(
    createEntry({ type: "agent_message", idGen, content: "Hi there" }),
  );
  const tc = turn.addChild(
    createEntry({
      type: "tool_call",
      idGen,
      props: { toolName: "read", callId: "c1" },
    }),
  );
  tc.addChild(
    createEntry({
      type: "tool_request",
      idGen,
      props: { args: { path: "/tmp" } },
    }),
  );
  tc.addChild(
    createEntry({
      type: "tool_response",
      idGen,
      content: "file contents",
      props: { isError: false },
    }),
  );

  return { session, idGen };
}

describe("treeToJson", () => {
  it("produces nested structure", () => {
    const { session } = makeTree();
    const json = treeToJson(session);
    expect(json.props.type).toBe("session");
    expect(json.children).toHaveLength(1);
    expect(json.children?.[0]?.children).toHaveLength(3); // user, agent, tool_call
  });

  it("preserves content and props", () => {
    const { session } = makeTree();
    const json = treeToJson(session);
    const turn = json.children?.[0];
    expect(turn?.props.turnNumber).toBe(1);
    const user = turn?.children?.[0];
    expect(user?.content).toBe("Hello");
  });

  it("omits children for leaf nodes", () => {
    const { session } = makeTree();
    const json = treeToJson(session);
    const user = json.children?.[0]?.children?.[0];
    expect(user?.children).toBeUndefined();
  });
});

describe("jsonToTree", () => {
  it("reconstructs tree with parent refs", () => {
    const { session } = makeTree();
    const json = treeToJson(session);
    const restored = jsonToTree(json, defaultFactory);

    expect(restored.id).toBe(session.id);
    expect(restored.children).toHaveLength(1);
    const turn = restored.children[0];
    expect(turn?.parent).toBe(restored);
    expect(turn?.parentId).toBe(restored.id);
  });

  it("bubbleUp works on restored tree", () => {
    const { session } = makeTree();
    const json = treeToJson(session);
    const restored = jsonToTree(json, defaultFactory);

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
    const restored = jsonToTree(json, defaultFactory);
    const jsonAgain = treeToJson(restored);
    expect(jsonAgain).toEqual(json);
  });
});
