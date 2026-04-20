import { describe, expect, it } from "vitest";
import {
  createDefaultPinPolicy,
  createPinPolicy,
} from "../../src/context/pin-policy.js";
import {
  createAgentNodeFactory,
  NodeType,
  type Session,
  type ToolCall,
} from "../../src/state/index.js";

function makeSession(): Session {
  const factory = createAgentNodeFactory();
  return factory({ type: NodeType.session }) as Session;
}

describe("createPinPolicy (composition)", () => {
  it("empty predicate list pins nothing", () => {
    const policy = createPinPolicy({ predicates: [] });
    const session = makeSession();
    const turn = session.addTurn();
    const userMsg = turn.addUserMessage("hello");
    expect(policy.shouldPin(userMsg)).toBe(false);
  });

  it("OR-composes predicates", () => {
    const session = makeSession();
    const turn = session.addTurn();
    const userMsg = turn.addUserMessage("hello");
    const policy = createPinPolicy({
      predicates: [(n) => n.type === NodeType.userMessage, () => false],
    });
    expect(policy.shouldPin(userMsg)).toBe(true);
  });
});

describe("createDefaultPinPolicy", () => {
  it("pins the latest user message", () => {
    const session = makeSession();
    const t1 = session.addTurn();
    const u1 = t1.addUserMessage("first");
    const t2 = session.addTurn();
    const u2 = t2.addUserMessage("second");

    const policy = createDefaultPinPolicy();
    policy.prepare?.(session);
    expect(policy.shouldPin(u2)).toBe(true);
    expect(policy.shouldPin(u1)).toBe(false);
  });

  it("pins the latest stateful tool call per default name", () => {
    const session = makeSession();
    const turn = session.addTurn();
    const first = turn.addToolCall("c1", "use_skills", { q: "a" });
    const second = turn.addToolCall("c2", "use_skills", { q: "b" });
    const other = turn.addToolCall("c3", "read_file", { path: "/x" });

    const policy = createDefaultPinPolicy();
    policy.prepare?.(session);
    expect(policy.shouldPin(second)).toBe(true);
    expect(policy.shouldPin(first)).toBe(false);
    expect(policy.shouldPin(other)).toBe(false);
  });

  it("honours props.pinned === true", () => {
    const session = makeSession();
    const turn = session.addTurn();
    const msg = turn.addAgentMessage();
    msg.props.pinned = true;

    const policy = createDefaultPinPolicy();
    policy.prepare?.(session);
    expect(policy.shouldPin(msg)).toBe(true);
  });

  it("honours additionalPredicates", () => {
    const session = makeSession();
    const turn = session.addTurn();
    const custom = turn.addToolCall("c1", "my_custom_tool", {});

    const policy = createDefaultPinPolicy({
      additionalPredicates: [
        (n) =>
          n.type === NodeType.toolCall &&
          (n as ToolCall).toolName === "my_custom_tool",
      ],
    });
    policy.prepare?.(session);
    expect(policy.shouldPin(custom)).toBe(true);
  });

  it("custom pinStatefulTools overrides defaults", () => {
    const session = makeSession();
    const turn = session.addTurn();
    const listSkills = turn.addToolCall("c1", "use_skills", {});
    const myStateful = turn.addToolCall("c2", "my_state", {});

    const policy = createDefaultPinPolicy({ pinStatefulTools: ["my_state"] });
    policy.prepare?.(session);
    expect(policy.shouldPin(myStateful)).toBe(true);
    expect(policy.shouldPin(listSkills)).toBe(false);
  });
});
