import { SnowflakeId } from "@repo/ids";
import { describe, expect, it } from "vitest";
import { toFlatStream } from "../src/flat-stream.js";
import { TreeEntry } from "../src/tree-entry.js";

function makeTree() {
  let time = 1700000000000;
  const idGen = new SnowflakeId({ now: () => time++ });

  const session = new TreeEntry({ type: "session", idGen });
  const turn = new TreeEntry({
    type: "turn",
    idGen,
    props: { turnNumber: 1 },
  });
  const user = new TreeEntry({
    type: "user_message",
    idGen,
    content: "Hello",
  });
  const agent = new TreeEntry({
    type: "agent_message",
    idGen,
    content: "Hi there",
  });
  const thinking = new TreeEntry({
    type: "thinking",
    idGen,
    content: "Let me think...",
  });

  session.addChild(turn);
  turn.addChild(user);
  turn.addChild(agent);
  agent.addChild(thinking);

  return { session, turn, user, agent, thinking, idGen };
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

    const sinceId = idGen.generate();

    const newTurn = new TreeEntry({
      type: "turn",
      idGen,
      props: { turnNumber: 2 },
    });
    const newMsg = new TreeEntry({
      type: "user_message",
      idGen,
      content: "new message",
    });
    session.addChild(newTurn);
    newTurn.addChild(newMsg);

    const nodes = [...toFlatStream(session, sinceId)];
    const ids = nodes.map((n) => n.id);

    expect(ids).toContain(newTurn.id);
    expect(ids).toContain(newMsg.id);
    expect(nodes.length).toBe(2);
  });

  it("emits modified old nodes (updatedAt >= since time)", () => {
    const { session, agent, idGen } = makeTree();

    const sinceId = idGen.generate();

    agent.content = "Hi there, updated!";
    agent.touch();

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

    agent.touch();

    const newTurn = new TreeEntry({ type: "turn", idGen });
    session.addChild(newTurn);

    const nodes = [...toFlatStream(session, sinceId)];
    const ids = nodes.map((n) => n.id);

    expect(ids).toContain(agent.id);
    expect(ids).toContain(newTurn.id);
  });
});
