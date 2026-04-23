import { describe, expect, it } from "vitest";
import { newNodeFactory } from "../../src/node-factory.js";
import { toFlatStream } from "../../src/serialization/to-flat-stream.js";

const factory = newNodeFactory({});

function makeTree() {
  const session = factory({ type: "session" });
  const turn = session.addChild({ type: "turn", props: { turnNumber: 1 } });
  const user = turn.addChild({ type: "user_message", content: "Hello" });
  const agent = turn.addChild({ type: "agent_message", content: "Hi there" });
  const thinking = agent.addChild({
    type: "thinking",
    content: "Let me think...",
  });

  return { session, turn, user, agent, thinking };
}

describe("toFlatStream (full)", () => {
  it("includes all nodes", () => {
    const { session } = makeTree();
    expect([...toFlatStream(session)]).toHaveLength(5);
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
    expect([...toFlatStream(session)][0]?.parentId).toBeUndefined();
  });

  it("children reference parent via parentId", () => {
    const { session, turn, user, agent, thinking } = makeTree();
    const byId = new Map([...toFlatStream(session)].map((n) => [n.id, n]));
    expect(byId.get(turn.id)?.parentId).toBe(session.id);
    expect(byId.get(user.id)?.parentId).toBe(turn.id);
    expect(byId.get(agent.id)?.parentId).toBe(turn.id);
    expect(byId.get(thinking.id)?.parentId).toBe(agent.id);
  });

  it("preserves content and props", () => {
    const { session, user, turn } = makeTree();
    const nodes = [...toFlatStream(session)];
    expect(nodes.find((n) => n.id === user.id)?.content).toBe("Hello");
    expect(nodes.find((n) => n.id === turn.id)?.props.turnNumber).toBe(1);
  });
});

describe("toFlatStream (since filter)", () => {
  it("emits new nodes", () => {
    const { session } = makeTree();
    const cursor = factory({ type: "_cursor" });
    const sinceId = cursor.id;

    const newTurn = session.addChild({
      type: "turn",
      props: { turnNumber: 2 },
    });
    newTurn.addChild({ type: "user_message", content: "new" });

    const nodes = [...toFlatStream(session, sinceId)];
    expect(nodes).toHaveLength(2);
  });

  it("emits modified old nodes", () => {
    const { session, agent } = makeTree();
    const cursor = factory({ type: "_cursor" });
    const sinceId = cursor.id;

    agent.content = "Hi there, updated!";
    agent.touch();

    const nodes = [...toFlatStream(session, sinceId)];
    expect(nodes.find((n) => n.id === agent.id)?.content).toBe("Hi there, updated!");
  });

  it("emits both new and modified", () => {
    const { session, agent } = makeTree();
    const cursor = factory({ type: "_cursor" });
    const sinceId = cursor.id;

    agent.touch();
    session.addChild({ type: "turn" });

    const nodes = [...toFlatStream(session, sinceId)];
    expect(nodes.map((n) => n.id)).toContain(agent.id);
    expect(nodes.length).toBeGreaterThanOrEqual(2);
  });
});
