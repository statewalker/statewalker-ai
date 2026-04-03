import { SnowflakeId } from "@repo/ids";
import { describe, expect, it, vi } from "vitest";
import { applyFlat } from "../src/apply-flat.js";
import { createEntry } from "../src/create-entry.js";
import { toFlatStream } from "../src/flat-stream.js";
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

  return { session, turn, idGen };
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
    const clone = applyFlat(undefined, toFlatStream(session), defaultFactory);

    expect(clone.id).toBe(session.id);
    expect(clone.type).toBe("session");
    expect(clone.children).toHaveLength(1);
    expect(clone.children[0]?.type).toBe("turn");
    expect(clone.children[0]?.children).toHaveLength(2);
  });

  it("preserves all IDs", () => {
    const { session } = makeTree();
    const clone = applyFlat(undefined, toFlatStream(session), defaultFactory);
    expect(treeIds(clone)).toEqual(treeIds(session));
  });

  it("preserves content and props", () => {
    const { session } = makeTree();
    const clone = applyFlat(undefined, toFlatStream(session), defaultFactory);
    const turnClone = clone.children[0];
    expect(turnClone?.props.turnNumber).toBe(1);
    expect(turnClone?.children[0]?.content).toBe("Hello");
    expect(turnClone?.children[1]?.content).toBe("Hi there");
  });

  it("wires parent references", () => {
    const { session } = makeTree();
    const clone = applyFlat(undefined, toFlatStream(session), defaultFactory);
    const turnClone = clone.children[0];
    expect(turnClone?.parent).toBe(clone);
    expect(turnClone?.parentId).toBe(clone.id);
  });

  it("bubbleUp works on cloned tree", () => {
    const { session } = makeTree();
    const clone = applyFlat(undefined, toFlatStream(session), defaultFactory);
    const listener = vi.fn();
    clone.onUpdate(listener);
    clone.children[0]?.children[0]?.bubbleUp();
    expect(listener).toHaveBeenCalled();
  });
});

describe("applyFlat: update existing tree", () => {
  it("updates content of existing node", () => {
    const { session } = makeTree();
    const agent = session.children[0]?.children[1];
    const clone = applyFlat(undefined, toFlatStream(session), defaultFactory);
    const agentClone = clone.children[0]?.children[1];
    expect(agentClone?.content).toBe("Hi there");

    applyFlat(
      clone,
      [
        {
          id: agent?.id ?? "",
          parentId: clone.children[0]?.id,
          props: { type: "agent_message", updatedAt: new Date().toISOString() },
          content: "Hi there, updated!",
        },
      ],
      defaultFactory,
    );

    expect(agentClone?.content).toBe("Hi there, updated!");
  });

  it("adds new node to existing tree", () => {
    const { session, idGen } = makeTree();
    const clone = applyFlat(undefined, toFlatStream(session), defaultFactory);
    const newId = idGen.generate();

    applyFlat(
      clone,
      [
        {
          id: newId,
          parentId: session.id,
          props: { type: "turn", turnNumber: 2 },
        },
      ],
      defaultFactory,
    );

    expect(clone.children).toHaveLength(2);
    expect(clone.children[1]?.props.turnNumber).toBe(2);
  });
});

describe("applyFlat: round-trip", () => {
  it("toFlatStream -> applyFlat produces equivalent tree", () => {
    const { session } = makeTree();
    const clone = applyFlat(undefined, toFlatStream(session), defaultFactory);
    expect(treeIds(clone)).toEqual(treeIds(session));
    expect([...toFlatStream(clone)]).toEqual([...toFlatStream(session)]);
  });
});

describe("applyFlat: incremental sync", () => {
  it("syncs new and modified nodes", () => {
    const { session, idGen } = makeTree();
    const tree2 = applyFlat(undefined, toFlatStream(session), defaultFactory);
    const sinceId = idGen.generate();

    const agent = session.children[0]?.children[1];
    if (agent) {
      agent.content = "Updated reply";
      agent.touch();
    }
    session.addChild(
      createEntry({ type: "turn", idGen, props: { turnNumber: 2 } }),
    );

    applyFlat(tree2, toFlatStream(session, sinceId), defaultFactory);
    expect(tree2.children[0]?.children[1]?.content).toBe("Updated reply");
    expect(tree2.children).toHaveLength(2);
  });
});

describe("applyFlat: idempotent", () => {
  it("applying same stream twice is a no-op", () => {
    const { session } = makeTree();
    const clone = applyFlat(undefined, toFlatStream(session), defaultFactory);
    const stream = [...toFlatStream(session)];
    applyFlat(clone, stream, defaultFactory);
    applyFlat(clone, stream, defaultFactory);
    expect(clone.children).toHaveLength(1);
    expect(treeIds(clone)).toEqual(treeIds(session));
  });
});
