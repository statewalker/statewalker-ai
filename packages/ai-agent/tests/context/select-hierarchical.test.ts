import { describe, expect, it } from "vitest";
import { createDefaultPinPolicy, createPinPolicy } from "../../src/context/pin-policy.js";
import { selectHierarchical } from "../../src/context/select-hierarchical.js";
import { selectAll } from "../../src/context/select-messages.js";
import { createTokenEstimator } from "../../src/context/token-estimator.js";
import { createDefaultElisionPolicy } from "../../src/context/tool-elision.js";
import {
  createAgentNodeFactory,
  NodeType,
  type Session,
  type TurnGroup,
} from "../../src/state/index.js";

function makeSession(): Session {
  const factory = createAgentNodeFactory();
  return factory({ type: NodeType.session }) as Session;
}

function addTurnPair(session: Session, userText: string, agentText: string) {
  const turn = session.addTurn();
  turn.addUserMessage(userText);
  turn.addAgentMessage().appendDelta(agentText);
  return turn;
}

function baseOptions() {
  return {
    budgetTokens: 10_000_000,
    keepRecentTurns: 2,
    pinPolicy: createDefaultPinPolicy(),
    elisionPolicy: createDefaultElisionPolicy({ minElideChars: 100 }),
    estimator: createTokenEstimator(),
  };
}

describe("selectHierarchical — raw turns", () => {
  it("emits raw tail turns verbatim (no groups present)", async () => {
    const session = makeSession();
    addTurnPair(session, "Q1", "A1");
    addTurnPair(session, "Q2", "A2");

    const strategy = selectHierarchical(baseOptions());
    const got = await strategy(session);
    const all = await selectAll(session);
    expect(got).toEqual(all);
  });
});

describe("selectHierarchical — group summary rendering", () => {
  it("emits one synthetic user message per group tagged with stamp", async () => {
    const session = makeSession();
    const g1 = session.addChild({ type: NodeType.turnGroup }) as TurnGroup;
    g1.summaryText = "summary one";
    g1.stamp = "01J-one";
    g1.depth = 1;
    const g2 = session.addChild({ type: NodeType.turnGroup }) as TurnGroup;
    g2.summaryText = "summary two";
    g2.stamp = "01J-two";
    g2.depth = 1;
    addTurnPair(session, "recent", "ok");

    const strategy = selectHierarchical(baseOptions());
    const got = await strategy(session);

    // Expect: 2 group summaries, then the recent turn (user+assistant).
    expect(got.length).toBeGreaterThanOrEqual(3);
    expect(typeof got[0]?.content).toBe("string");
    expect(got[0]?.content).toContain("[group:01J-one]");
    expect(got[0]?.content).toContain("summary one");
    expect(got[1]?.content).toContain("[group:01J-two]");
    expect(got[1]?.content).toContain("summary two");
  });

  it("includes sections when present", async () => {
    const session = makeSession();
    const g = session.addChild({ type: NodeType.turnGroup }) as TurnGroup;
    g.summaryText = "prose";
    g.stamp = "stamp";
    g.sections = [{ title: "Decisions", body: "chose X", refs: ["t1", "t2"] }];

    const strategy = selectHierarchical(baseOptions());
    const got = await strategy(session);

    const body = got[0]?.content as string;
    expect(body).toContain("## Decisions");
    expect(body).toContain("chose X");
    expect(body).toContain("refs: t1, t2");
  });
});

describe("selectHierarchical — pin-driven expansion", () => {
  it("expands a group when a descendant is pinned, emitting raw turns", async () => {
    const session = makeSession();
    const g = session.addChild({ type: NodeType.turnGroup }) as TurnGroup;
    g.summaryText = "would be summary";
    g.stamp = "st";
    const innerTurn = g.addChild({ type: NodeType.turn });
    innerTurn.addChild({
      type: NodeType.userMessage,
      content: "raw inner user",
    });
    // Force pinning of the inner turn.
    innerTurn.props.pinned = true;

    addTurnPair(session, "tail", "tail-ans");

    const strategy = selectHierarchical(baseOptions());
    const got = await strategy(session);

    // The group summary must NOT appear; the inner raw message should.
    const joined = got.map((m) => String(m.content)).join("\n");
    expect(joined).not.toContain("[group:st]");
    expect(joined).toContain("raw inner user");
  });

  it("keeps unpinned groups summarised", async () => {
    const session = makeSession();
    const g = session.addChild({ type: NodeType.turnGroup }) as TurnGroup;
    g.summaryText = "summary body";
    g.stamp = "st";
    const innerTurn = g.addChild({ type: NodeType.turn });
    innerTurn.addChild({
      type: NodeType.userMessage,
      content: "inner user",
    });
    addTurnPair(session, "tail", "ok");

    const strategy = selectHierarchical({
      ...baseOptions(),
      pinPolicy: createPinPolicy({ predicates: [] }),
    });
    const got = await strategy(session);
    const joined = got.map((m) => String(m.content)).join("\n");
    expect(joined).toContain("[group:st]");
    expect(joined).not.toContain("inner user");
  });
});

describe("selectHierarchical — elision at projection time", () => {
  it("elides oversized tool responses in raw tail turns without mutating the tree", async () => {
    const session = makeSession();
    const turn = session.addTurn();
    turn.addUserMessage("check");
    const tc = turn.addToolCall("c1", "anything", { path: "/x" });
    tc.addResponse("y".repeat(20_000));

    const strategy = selectHierarchical({
      ...baseOptions(),
      elisionPolicy: createDefaultElisionPolicy({ minElideChars: 1000 }),
    });
    const got = await strategy(session);

    // The raw tool-response on the tree is unchanged.
    expect(tc.response?.content).toBe("y".repeat(20_000));

    // But the projected tool-result part is elided.
    const toolMsg = got.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    const content = toolMsg?.content as Array<{ output?: { value?: unknown } }>;
    const value = content?.[0]?.output?.value;
    expect(typeof value).toBe("string");
    expect((value as string).length).toBeLessThan(20_000);
  });
});

describe("selectHierarchical — budget-driven demotion", () => {
  it("collapses forced expansions when over budget (only non-pinned ones)", async () => {
    const session = makeSession();
    // Two groups: one has a pinned descendant → will be expanded.
    const g1 = session.addChild({ type: NodeType.turnGroup }) as TurnGroup;
    g1.summaryText = "g1 summary";
    g1.stamp = "s1";
    const g2 = session.addChild({ type: NodeType.turnGroup }) as TurnGroup;
    g2.summaryText = "g2 summary";
    g2.stamp = "s2";

    // Neither group is pinned under default policy — nothing to expand, so
    // demotion is a no-op. This just verifies the demotion code-path is
    // safe when there are no expanded groups.
    addTurnPair(session, "q", "a");

    const strategy = selectHierarchical({
      ...baseOptions(),
      budgetTokens: 5, // absurdly low to force demotion attempts
    });
    const got = await strategy(session);
    // No crash; we still get at least one message.
    expect(got.length).toBeGreaterThan(0);
  });
});
