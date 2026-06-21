import { describe, expect, it, vi } from "vitest";
import { applyFlat } from "../../../src/state/serialization/apply-flat.js";
import { toFlatStream } from "../../../src/state/serialization/to-flat-stream.js";
import type { TreeNode } from "../../../src/state/tree-node.js";
import { newNodeFactory } from "../../../src/state/tree-node-factory.js";

const factory = newNodeFactory({});

function makeTree() {
  const session = factory({ type: "session" });
  const turn = session.addChild({ type: "turn", props: { turnNumber: 1 } });
  turn.addChild({ type: "user_message", content: "Hello" });
  turn.addChild({ type: "agent_message", content: "Hi there" });
  return { session, turn };
}

function treeIds(node: TreeNode): string[] {
  const ids: string[] = [];
  node.visit((e) => {
    ids.push(e.id);
    return undefined;
  });
  return ids;
}

describe("applyFlat: build from scratch", () => {
  it("builds a tree from flat stream", () => {
    const { session } = makeTree();
    const clone = applyFlat(undefined, toFlatStream(session), factory);
    expect(clone.id).toBe(session.id);
    expect(clone.type).toBe("session");
    expect(clone.children).toHaveLength(1);
    expect(clone.children[0]?.children).toHaveLength(2);
  });

  it("preserves all IDs", () => {
    const { session } = makeTree();
    const clone = applyFlat(undefined, toFlatStream(session), factory);
    expect(treeIds(clone)).toEqual(treeIds(session));
  });

  it("preserves content and props", () => {
    const { session } = makeTree();
    const clone = applyFlat(undefined, toFlatStream(session), factory);
    const turnClone = clone.children[0];
    expect(turnClone?.props.turnNumber).toBe(1);
    expect(turnClone?.children[0]?.content).toBe("Hello");
    expect(turnClone?.children[1]?.content).toBe("Hi there");
  });

  it("wires parent references", () => {
    const { session } = makeTree();
    const clone = applyFlat(undefined, toFlatStream(session), factory);
    expect(clone.children[0]?.parent).toBe(clone);
    expect(clone.children[0]?.parentId).toBe(clone.id);
  });

  it("bubbleUp works on cloned tree", () => {
    const { session } = makeTree();
    const clone = applyFlat(undefined, toFlatStream(session), factory);
    const listener = vi.fn();
    clone.onUpdate(listener);
    clone.children[0]?.children[0]?.bubbleUp();
    expect(listener).toHaveBeenCalled();
  });
});

describe("applyFlat: update + sync + idempotent", () => {
  it("updates content of existing node", () => {
    const { session } = makeTree();
    const agentId = session.children[0]?.children[1]?.id ?? "";
    const clone = applyFlat(undefined, toFlatStream(session), factory);
    const agentClone = clone.children[0]?.children[1];

    applyFlat(
      clone,
      [
        {
          id: agentId,
          props: { type: "agent_message", updatedAt: new Date().toISOString() },
          content: "Updated!",
        },
      ],
      factory,
    );

    expect(agentClone?.content).toBe("Updated!");
  });

  it("round-trip produces equivalent tree", () => {
    const { session } = makeTree();
    const clone = applyFlat(undefined, toFlatStream(session), factory);
    expect(treeIds(clone)).toEqual(treeIds(session));
    expect([...toFlatStream(clone)]).toEqual([...toFlatStream(session)]);
  });

  it("incremental sync", () => {
    const { session } = makeTree();
    const tree2 = applyFlat(undefined, toFlatStream(session), factory);
    const cursor = factory({ type: "_cursor" });

    const agent = session.children[0]?.children[1];
    if (agent) {
      agent.content = "Updated";
      agent.touch();
    }
    session.addChild({ type: "turn", props: { turnNumber: 2 } });

    applyFlat(tree2, toFlatStream(session, cursor.id), factory);
    expect(tree2.children[0]?.children[1]?.content).toBe("Updated");
    expect(tree2.children).toHaveLength(2);
  });

  it("idempotent apply", () => {
    const { session } = makeTree();
    const clone = applyFlat(undefined, toFlatStream(session), factory);
    const stream = [...toFlatStream(session)];
    applyFlat(clone, stream, factory);
    applyFlat(clone, stream, factory);
    expect(clone.children).toHaveLength(1);
    expect(treeIds(clone)).toEqual(treeIds(session));
  });
});
