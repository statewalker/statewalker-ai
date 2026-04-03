import { SnowflakeId } from "@repo/ids";
import { describe, expect, it, vi } from "vitest";
import { applyFlat } from "../src/apply-flat.js";
import { toFlatStream } from "../src/flat-stream.js";
import { TreeEntry } from "../src/tree-entry.js";

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

  session.addChild(turn);
  turn.addChild(user);
  turn.addChild(agent);

  return { session, turn, user, agent, idGen };
}

function treeIds(entry: TreeEntry): string[] {
  const ids: string[] = [];
  entry.visit((node) => {
    ids.push(node.id);
  });
  return ids;
}

/** Safe child access — throws if missing instead of using non-null assertions */
function ch(entry: TreeEntry, index: number): TreeEntry {
  const c = entry.children?.[index];
  if (!c) throw new Error(`No child at index ${index}`);
  return c;
}

describe("applyFlat: build from scratch", () => {
  it("builds a tree from flat stream", () => {
    const { session } = makeTree();
    const stream = toFlatStream(session);
    const clone = applyFlat(undefined, stream);

    expect(clone.id).toBe(session.id);
    expect(clone.type).toBe("session");
    expect(clone.children).toHaveLength(1);
    expect(ch(clone, 0).type).toBe("turn");
    expect(ch(clone, 0).children).toHaveLength(2);
  });

  it("preserves all IDs", () => {
    const { session } = makeTree();
    const originalIds = treeIds(session);
    const clone = applyFlat(undefined, toFlatStream(session));
    const clonedIds = treeIds(clone);

    expect(clonedIds).toEqual(originalIds);
  });

  it("preserves content and props", () => {
    const { session } = makeTree();
    const clone = applyFlat(undefined, toFlatStream(session));

    const turnClone = ch(clone, 0);
    expect(turnClone.props.turnNumber).toBe(1);
    expect(ch(turnClone, 0).content).toBe("Hello");
    expect(ch(turnClone, 1).content).toBe("Hi there");
  });

  it("wires parent references", () => {
    const { session } = makeTree();
    const clone = applyFlat(undefined, toFlatStream(session));

    const turnClone = ch(clone, 0);
    expect(turnClone.parent).toBe(clone);
    expect(turnClone.parentId).toBe(clone.id);
    expect(ch(turnClone, 0).parent).toBe(turnClone);
  });

  it("bubbleUp works on cloned tree", () => {
    const { session } = makeTree();
    const clone = applyFlat(undefined, toFlatStream(session));

    const listener = vi.fn();
    clone.onUpdate(listener);

    ch(ch(clone, 0), 0).bubbleUp();
    expect(listener).toHaveBeenCalled();
  });
});

describe("applyFlat: update existing tree", () => {
  it("updates content of existing node", () => {
    const { session, agent } = makeTree();
    const clone = applyFlat(undefined, toFlatStream(session));

    const agentClone = ch(ch(clone, 0), 1);
    expect(agentClone.content).toBe("Hi there");

    applyFlat(clone, [
      {
        id: agent.id,
        type: "agent_message",
        parentId: ch(clone, 0).id,
        props: { updatedAt: new Date().toISOString() },
        content: "Hi there, updated!",
      },
    ]);

    expect(agentClone.content).toBe("Hi there, updated!");
  });

  it("merges props on update", () => {
    const { session, turn } = makeTree();
    const clone = applyFlat(undefined, toFlatStream(session));
    const turnClone = ch(clone, 0);

    applyFlat(clone, [
      {
        id: turn.id,
        type: "turn",
        parentId: session.id,
        props: { stopReason: "stop", model: "claude-3" },
      },
    ]);

    expect(turnClone.props.turnNumber).toBe(1);
    expect(turnClone.props.stopReason).toBe("stop");
    expect(turnClone.props.model).toBe("claude-3");
  });

  it("adds new node to existing tree", () => {
    const { session, idGen } = makeTree();
    const clone = applyFlat(undefined, toFlatStream(session));

    const newTurnId = idGen.generate();
    const newMsgId = idGen.generate();

    applyFlat(clone, [
      {
        id: newTurnId,
        type: "turn",
        parentId: session.id,
        props: { turnNumber: 2 },
      },
      {
        id: newMsgId,
        type: "user_message",
        parentId: newTurnId,
        props: {},
        content: "New message",
      },
    ]);

    expect(clone.children).toHaveLength(2);
    const newTurn = ch(clone, 1);
    expect(newTurn.id).toBe(newTurnId);
    expect(newTurn.children).toHaveLength(1);
    expect(ch(newTurn, 0).content).toBe("New message");
  });
});

describe("applyFlat: round-trip", () => {
  it("toFlatStream -> applyFlat produces equivalent tree", () => {
    const { session } = makeTree();
    const clone = applyFlat(undefined, toFlatStream(session));

    expect(treeIds(clone)).toEqual(treeIds(session));

    const original = [...toFlatStream(session)];
    const cloned = [...toFlatStream(clone)];
    expect(cloned).toEqual(original);
  });
});

describe("applyFlat: incremental sync", () => {
  it("syncs new and modified nodes between trees", () => {
    const { session, agent, idGen } = makeTree();
    const tree2 = applyFlat(undefined, toFlatStream(session));

    const sinceId = idGen.generate();

    agent.content = "Updated reply";
    agent.touch();

    const newTurn = new TreeEntry({
      type: "turn",
      idGen,
      props: { turnNumber: 2 },
    });
    session.addChild(newTurn);

    const delta = toFlatStream(session, sinceId);
    applyFlat(tree2, delta);

    expect(ch(ch(tree2, 0), 1).content).toBe("Updated reply");
    expect(tree2.children).toHaveLength(2);
    expect(ch(tree2, 1).props.turnNumber).toBe(2);
  });
});

describe("applyFlat: idempotent", () => {
  it("applying same stream twice is a no-op", () => {
    const { session } = makeTree();
    const clone = applyFlat(undefined, toFlatStream(session));

    const stream = [...toFlatStream(session)];
    applyFlat(clone, stream);
    applyFlat(clone, stream);

    expect(clone.children).toHaveLength(1);
    expect(ch(clone, 0).children).toHaveLength(2);
    expect(treeIds(clone)).toEqual(treeIds(session));
  });
});
