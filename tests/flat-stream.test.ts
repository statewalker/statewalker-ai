import { SnowflakeId } from "@repo/ids";
import { describe, expect, it } from "vitest";
import { toFlatStream } from "../src/flat-stream.js";
import { createEntry, TreeNode } from "../src/tree-node.js";
import type { NodeRegistry } from "../src/types.js";

const emptyRegistry: NodeRegistry = new Map();

function makeTree() {
  let time = 1700000000000;
  const idGen = new SnowflakeId({ now: () => time++ });

  const session = new TreeNode(
    createEntry({ type: "session", idGen }),
    emptyRegistry,
  );
  const turn = session.addChild(
    createEntry({ type: "turn", idGen, props: { turnNumber: 1 } }),
  );
  const user = turn.addChild(
    createEntry({ type: "user_message", idGen, content: "Hello" }),
  );
  const agent = turn.addChild(
    createEntry({ type: "agent_message", idGen, content: "Hi there" }),
  );
  const thinking = agent.addChild(
    createEntry({ type: "thinking", idGen, content: "Let me think..." }),
  );

  return { session, turn, user, agent, thinking, idGen };
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
    const { session, idGen } = makeTree();
    const sinceId = idGen.generate();

    const newTurn = session.addChild(
      createEntry({ type: "turn", idGen, props: { turnNumber: 2 } }),
    );
    newTurn.addChild(
      createEntry({ type: "user_message", idGen, content: "new" }),
    );

    const nodes = [...toFlatStream(session, sinceId)];
    expect(nodes).toHaveLength(2);
  });

  it("emits modified old nodes", () => {
    const { session, agent, idGen } = makeTree();
    const sinceId = idGen.generate();

    agent.content = "Hi there, updated!";
    agent.touch();

    const nodes = [...toFlatStream(session, sinceId)];
    expect(nodes.find((n) => n.id === agent.id)?.content).toBe(
      "Hi there, updated!",
    );
  });

  it("emits both new and modified", () => {
    const { session, agent, idGen } = makeTree();
    const sinceId = idGen.generate();
    agent.touch();
    session.addChild(createEntry({ type: "turn", idGen }));

    const nodes = [...toFlatStream(session, sinceId)];
    expect(nodes.map((n) => n.id)).toContain(agent.id);
    expect(nodes.length).toBeGreaterThanOrEqual(2);
  });
});
