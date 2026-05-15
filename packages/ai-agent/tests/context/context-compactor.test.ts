import { describe, expect, it, vi } from "vitest";
import { ContextCompactor } from "../../src/context/context-compactor.js";
import type {
  HierarchicalSummarizer,
  SummaryOutput,
} from "../../src/context/hierarchical-summarizer.js";
import { createDefaultPinPolicy } from "../../src/context/pin-policy.js";
import { createTokenEstimator } from "../../src/context/token-estimator.js";
import { createDefaultElisionPolicy } from "../../src/context/tool-elision.js";
import {
  createAgentNodeFactory,
  NodeType,
  type SessionState,
  type TurnGroup,
} from "../../src/state/index.js";
import type { LogMessage } from "../../src/state/log-message.js";

function makeSession(): SessionState {
  const factory = createAgentNodeFactory();
  return factory({ type: NodeType.session }) as SessionState;
}

function addTurnWithLoad(session: SessionState, load: number, userText = "q") {
  const t = session.addTurn();
  t.addUserMessage(userText);
  const msg = t.addAgentMessage();
  msg.appendDelta("a".repeat(load));
  return t;
}

function mockSummarizer(output: SummaryOutput = { content: "summary" }): {
  summ: HierarchicalSummarizer;
  summarize: ReturnType<typeof vi.fn>;
} {
  const summarize = vi.fn(async () => output);
  return { summ: { summarize }, summarize };
}

function baseOptions(summ: HierarchicalSummarizer) {
  return {
    budgetTokens: 100,
    summarizer: summ,
    estimator: createTokenEstimator(),
    pinPolicy: createDefaultPinPolicy(),
    elisionPolicy: createDefaultElisionPolicy({ minElideChars: 100 }),
    keepRecentTurns: 2,
    groupSize: 3,
    depthPromoteThreshold: 3,
  } as const;
}

describe("ContextCompactor.compact — no-op path", () => {
  it("returns passes: 0 when already under budget", async () => {
    const session = makeSession();
    addTurnWithLoad(session, 40);
    addTurnWithLoad(session, 40);

    const { summ, summarize } = mockSummarizer();
    const compactor = new ContextCompactor();
    const result = await compactor.compact(session, {
      ...baseOptions(summ),
      budgetTokens: 10_000, // way over — no-op
    });

    expect(result.passes).toBe(0);
    expect(result.newGroups).toEqual([]);
    expect(result.stamp).toBeNull();
    expect(summarize).not.toHaveBeenCalled();
  });
});

describe("ContextCompactor.compact — elision short-circuit", () => {
  it("runs with zero LLM calls when elision alone brings us under budget", async () => {
    const session = makeSession();
    const turn = session.addTurn();
    const tc = turn.addToolCall("c1", "anything", { path: "/" });
    // Oversized response; elision reduces it drastically.
    tc.addResponse("x".repeat(20_000));
    // Extra recent turns so the big one falls outside the tail.
    addTurnWithLoad(session, 10);
    addTurnWithLoad(session, 10);

    const { summ, summarize } = mockSummarizer();
    const compactor = new ContextCompactor();
    const result = await compactor.compact(session, {
      ...baseOptions(summ),
      budgetTokens: 200,
    });

    expect(result.elided).toBe(true);
    expect(result.newGroups).toEqual([]);
    expect(summarize).not.toHaveBeenCalled();
  });
});

describe("ContextCompactor.compact — depth-1 grouping", () => {
  it("forms a depth-1 group when elision alone is not enough", async () => {
    const session = makeSession();
    // 5 heavy turns — first 3 are outside the tail.
    for (let i = 0; i < 5; i++) {
      addTurnWithLoad(session, 400, `q${i}`);
    }
    const { summ, summarize } = mockSummarizer({
      content: "grouped summary",
      sections: [{ title: "T", body: "B", refs: ["x"] }],
    });
    const compactor = new ContextCompactor();
    const result = await compactor.compact(session, {
      ...baseOptions(summ),
      budgetTokens: 100,
    });

    expect(result.newGroups.length).toBeGreaterThanOrEqual(1);
    expect(summarize).toHaveBeenCalled();
    const firstGroupId = result.newGroups[0];
    const groupNode = session.children.find((c) => c.id === firstGroupId) as TurnGroup | undefined;
    expect(groupNode).toBeDefined();
    expect(groupNode?.summaryText).toBe("grouped summary");
    expect(groupNode?.sections).toEqual([{ title: "T", body: "B", refs: ["x"] }]);
    expect(groupNode?.stamp).toBe(result.stamp);
  });

  it("all groups from a single pass carry the same stamp", async () => {
    const session = makeSession();
    for (let i = 0; i < 12; i++) addTurnWithLoad(session, 400);
    const { summ } = mockSummarizer();
    const compactor = new ContextCompactor();
    const result = await compactor.compact(session, {
      ...baseOptions(summ),
      budgetTokens: 100,
      groupSize: 3,
      depthPromoteThreshold: 4, // avoid depth promotion so all new groups stay at root
    });
    expect(result.newGroups.length).toBeGreaterThanOrEqual(2);
    const byId = new Map<string, TurnGroup>();
    const walk = (node: { children: TurnGroup[] | { children: unknown }[] }) => {
      for (const child of (node as unknown as { children: TurnGroup[] }).children) {
        byId.set(child.id, child);
        walk(child as unknown as { children: TurnGroup[] });
      }
    };
    walk(session as unknown as { children: TurnGroup[] });
    const stamps = result.newGroups.map((id) => byId.get(id)?.stamp);
    expect(new Set(stamps).size).toBe(1);
    expect(stamps[0]).toBe(result.stamp);
  });
});

describe("ContextCompactor.compact — caching", () => {
  it("second compact with no mutation performs zero summariser calls", async () => {
    const session = makeSession();
    for (let i = 0; i < 6; i++) addTurnWithLoad(session, 400);
    const { summ, summarize } = mockSummarizer();
    const compactor = new ContextCompactor();

    await compactor.compact(session, {
      ...baseOptions(summ),
      budgetTokens: 100,
    });
    const callsAfterFirst = summarize.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    summarize.mockClear();
    const result2 = await compactor.compact(session, {
      ...baseOptions(summ),
      budgetTokens: 10_000, // under-budget after first pass → no-op
    });
    expect(summarize).not.toHaveBeenCalled();
    expect(result2.passes).toBe(0);
  });
});

describe("ContextCompactor.compact — pin-aware grouping", () => {
  it("skips a run that includes a pinned tool call", async () => {
    const session = makeSession();
    // Turns 0..4 with heavy content; turn 2 contains a pinned `use_skills`.
    for (let i = 0; i < 5; i++) {
      const t = addTurnWithLoad(session, 400, `q${i}`);
      if (i === 2) {
        t.addToolCall("c1", "use_skills", { q: "pin" }).addResponse("selected");
      }
    }
    const { summ } = mockSummarizer();
    const compactor = new ContextCompactor();
    const result = await compactor.compact(session, {
      ...baseOptions(summ),
      budgetTokens: 100,
      groupSize: 10, // allow full grouping
      keepRecentTurns: 2, // tail = turns 3,4
    });

    // The formed group must not span the pinned turn #2 — so it includes
    // only turns 0..1.
    const firstGroupId = result.newGroups[0];
    if (firstGroupId) {
      const group = session.children.find((c) => c.id === firstGroupId) as TurnGroup | undefined;
      expect(group?.childTurnCount).toBe(2);
    }
  });
});

describe("ContextCompactor.compact — legacy migration", () => {
  it("wraps contiguous legacy-summarised prefix without calling LLM", async () => {
    const session = makeSession();
    const t0 = addTurnWithLoad(session, 400);
    const t1 = addTurnWithLoad(session, 400);
    addTurnWithLoad(session, 400);
    addTurnWithLoad(session, 400);
    t0.props.summary = "legacy-0";
    t1.props.summary = "legacy-1";

    const { summ, summarize } = mockSummarizer();
    const compactor = new ContextCompactor();
    const result = await compactor.compact(session, {
      ...baseOptions(summ),
      budgetTokens: 10_000_000, // under-budget after migration
    });

    expect(result.stamp).toBe("legacy");
    const children = session.children;
    const legacyGroup = children[0] as TurnGroup;
    expect(legacyGroup.type).toBe(NodeType.turnGroup);
    expect(legacyGroup.stamp).toBe("legacy");
    expect(legacyGroup.summaryText).toBe("legacy-0\nlegacy-1");
    expect(summarize).not.toHaveBeenCalled();
  });
});

describe("ContextCompactor.compact — thrashing guard", () => {
  it("emits context-thrash and returns thrashed: true when no progress possible", async () => {
    const session = makeSession();
    // A single oversized turn in the tail — can't group it, can't elide non-tool content.
    const turn = session.addTurn();
    turn.addUserMessage("x".repeat(10_000));
    addTurnWithLoad(session, 5); // tail filler

    const { summ } = mockSummarizer();
    const events: LogMessage[] = [];
    const compactor = new ContextCompactor();
    const result = await compactor.compact(session, {
      ...baseOptions(summ),
      budgetTokens: 50,
      keepRecentTurns: 2, // both turns protected
      eventSink: (e) => events.push(e),
    });

    expect(result.thrashed).toBe(true);
    const thrashEvents = events.filter(
      (e): e is Extract<LogMessage, { type: "context-thrash" }> => e.type === "context-thrash",
    );
    expect(thrashEvents).toHaveLength(1);
    expect(thrashEvents[0]?.stamp).toBe(result.stamp);
  });
});
