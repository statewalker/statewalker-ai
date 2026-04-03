import { SnowflakeId } from "@repo/ids";
import { describe, expect, it } from "vitest";
import { toFlatStream } from "../src/flat-stream.js";
import { TreeEntry } from "../src/tree-entry.js";

function makeTree() {
  let time = 1700000000000;
  const idGen = new SnowflakeId({ now: () => time++ });

  const session = new TreeEntry("session", { idGen });
  const turn = new TreeEntry("turn", { idGen, props: { turnNumber: 1 } });
  const user = new TreeEntry("user_message", {
    idGen,
    content: "Hello",
  });
  const agent = new TreeEntry("agent_message", {
    idGen,
    content: "Hi there",
  });
  const thinking = new TreeEntry("thinking", {
    idGen,
    content: "Let me think...",
  });

  session.addChild(turn);
  turn.addChild(user);
  turn.addChild(agent);
  agent.addChild(thinking);

  return { session, turn, user, agent, thinking, idGen, getTime: () => time };
}

describe("toFlatStream (full)", () => {
  it("includes all nodes", () => {
    const { session } = makeTree();
    const nodes = [...toFlatStream(session)];
    expect(nodes).toHaveLength(5);
  });

  it("orders by id ascending", () => {
    const { session } = makeTree();
    const nodes = [...toFlatStream(session)];
    for (let i = 1; i < nodes.length; i++) {
      expect(nodes[i - 1]?.id < nodes[i]?.id).toBe(true);
    }
  });

  it("root has no parentId", () => {
    const { session } = makeTree();
    const nodes = [...toFlatStream(session)];
    expect(nodes[0]?.parentId).toBeUndefined();
  });

  it("children reference parent via parentId", () => {
    const { session, turn, user, agent, thinking } = makeTree();
    const nodes = [...toFlatStream(session)];
    const byId = new Map(nodes.map((n) => [n.id, n]));

    expect(byId.get(turn.id)?.parentId).toBe(session.id);
    expect(byId.get(user.id)?.parentId).toBe(turn.id);
    expect(byId.get(agent.id)?.parentId).toBe(turn.id);
    expect(byId.get(thinking.id)?.parentId).toBe(agent.id);
  });

  it("preserves content", () => {
    const { session, user } = makeTree();
    const nodes = [...toFlatStream(session)];
    const userNode = nodes.find((n) => n.id === user.id);
    expect(userNode?.content).toBe("Hello");
  });

  it("preserves props", () => {
    const { session, turn } = makeTree();
    const nodes = [...toFlatStream(session)];
    const turnNode = nodes.find((n) => n.id === turn.id);
    expect(turnNode?.props.turnNumber).toBe(1);
  });
});

describe("toFlatStream (since filter)", () => {
  it("emits new nodes (id >= since)", () => {
    const { session, idGen } = makeTree();

    // Record the "last known id" — anything after this is "new"
    const sinceId = idGen.generate();

    // Add a new turn after the checkpoint
    const newTurn = new TreeEntry("turn", {
      idGen,
      props: { turnNumber: 2 },
    });
    const newMsg = new TreeEntry("user_message", {
      idGen,
      content: "new message",
    });
    session.addChild(newTurn);
    newTurn.addChild(newMsg);

    const nodes = [...toFlatStream(session, sinceId)];
    const ids = nodes.map((n) => n.id);

    expect(ids).toContain(newTurn.id);
    expect(ids).toContain(newMsg.id);
    // Should not contain the original 5 nodes (all created before since)
    expect(nodes.length).toBe(2);
  });

  it("emits modified old nodes (updatedAt >= since time)", () => {
    const { session, agent, idGen } = makeTree();

    // Record checkpoint
    const sinceId = idGen.generate();

    // Modify an old node
    agent.content = "Hi there, updated!";
    agent.props.updatedAt = Date.now();
    agent.notify();

    const nodes = [...toFlatStream(session, sinceId)];
    const ids = nodes.map((n) => n.id);

    expect(ids).toContain(agent.id);
    expect(nodes.find((n) => n.id === agent.id)?.content).toBe(
      "Hi there, updated!",
    );
  });

  it("emits both new and modified nodes", () => {
    const { session, agent, idGen } = makeTree();

    const sinceId = idGen.generate();

    // Modify old node
    agent.props.updatedAt = Date.now();

    // Add new node
    const newTurn = new TreeEntry("turn", { idGen });
    session.addChild(newTurn);

    const nodes = [...toFlatStream(session, sinceId)];
    const ids = nodes.map((n) => n.id);

    expect(ids).toContain(agent.id); // modified
    expect(ids).toContain(newTurn.id); // new
  });
});
