import type { ProviderV3 } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import {
  ContextWindow,
  DEFAULT_SYSTEM_PROMPT,
  SKILLS_INSTRUCTION,
} from "../../src/context/context-window.js";
import type {
  HierarchicalSummarizer,
  SummaryOutput,
} from "../../src/context/hierarchical-summarizer.js";
import { createDefaultPinPolicy } from "../../src/context/pin-policy.js";
import { selectHierarchical } from "../../src/context/select-hierarchical.js";
import { createTokenEstimator } from "../../src/context/token-estimator.js";
import { createDefaultElisionPolicy } from "../../src/context/tool-elision.js";
import {
  createAgentNodeFactory,
  NodeType,
  type Session,
  SkillsModel,
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

function addHeavyTurn(session: Session, load: number, label = "q") {
  const turn = session.addTurn();
  turn.addUserMessage(label);
  turn.addAgentMessage().appendDelta("a".repeat(load));
  return turn;
}

function makeSummarizer(content = "summary"): HierarchicalSummarizer {
  const output: SummaryOutput = { content };
  return { summarize: vi.fn(async () => output) };
}

// Minimal `ProviderV3` stub — `ContextWindow.build()` does not invoke it.
const fakeProvider: ProviderV3 = {
  specificationVersion: "v3",
  languageModel: () => {
    throw new Error("not used in ContextWindow tests");
  },
  embeddingModel: () => {
    throw new Error("not supported");
  },
  imageModel: () => {
    throw new Error("not supported");
  },
};

describe("ContextWindow.build — no compaction configured", () => {
  it("returns the selectAll projection when no compaction is configured", async () => {
    const session = makeSession();
    addTurnPair(session, "Hi", "Hello");
    addTurnPair(session, "How?", "Fine");

    const cw = new ContextWindow({ provider: fakeProvider, model: "test" });
    const result = await cw.build(session, { skills: new SkillsModel() });

    // selectAll yields one user + one assistant message per turn.
    expect(result.messages.length).toBeGreaterThanOrEqual(4);
    expect(result.events).toEqual([]);
    expect(result.stats.compacted).toBe(false);
  });

  it("does not mutate the tree when no compaction is configured", async () => {
    const session = makeSession();
    for (let i = 0; i < 6; i++) addHeavyTurn(session, 200, `turn-${i}`);
    const before = session.children.map((c) => c.type);

    const cw = new ContextWindow({ provider: fakeProvider, model: "test" });
    await cw.build(session, { skills: new SkillsModel() });

    expect(session.children.map((c) => c.type)).toEqual(before);
  });
});

describe("ContextWindow.build — compaction configured", () => {
  it("returns empty events and compacted=false when already under budget", async () => {
    const session = makeSession();
    addTurnPair(session, "Hi", "Hello");

    const cw = new ContextWindow({
      provider: fakeProvider,
      model: "test",
      summarizer: makeSummarizer(),
      budgetTokens: 100_000,
      keepRecentTurns: 2,
      groupSize: 3,
      selectStrategy: selectHierarchical({
        budgetTokens: 100_000,
        keepRecentTurns: 2,
        pinPolicy: createDefaultPinPolicy(),
        elisionPolicy: createDefaultElisionPolicy(),
        estimator: createTokenEstimator(),
      }),
    });
    const result = await cw.build(session, { skills: new SkillsModel() });

    expect(result.events).toEqual([]);
    expect(result.stats.compacted).toBe(false);
  });

  it("triggers compaction when over budget — TurnGroup is created in state", async () => {
    const session = makeSession();
    for (let i = 0; i < 6; i++) addHeavyTurn(session, 400, `t${i}`);

    const summarizer = makeSummarizer("compacted summary");
    const pinPolicy = createDefaultPinPolicy();
    const cw = new ContextWindow({
      provider: fakeProvider,
      model: "test",
      summarizer,
      budgetTokens: 100,
      keepRecentTurns: 2,
      groupSize: 3,
      pinPolicy,
      elisionPolicy: createDefaultElisionPolicy({ minElideChars: 50_000 }),
      selectStrategy: selectHierarchical({
        budgetTokens: 100,
        keepRecentTurns: 2,
        pinPolicy,
        elisionPolicy: createDefaultElisionPolicy({ minElideChars: 50_000 }),
        estimator: createTokenEstimator(),
      }),
    });
    const result = await cw.build(session, { skills: new SkillsModel() });

    expect(result.stats.compacted).toBe(true);
    const hasGroup = session.children.some((c) => c.type === NodeType.turnGroup);
    expect(hasGroup).toBe(true);
    expect(summarizer.summarize).toHaveBeenCalled();
  });

  it("emits context-thrash event when budget unreachable", async () => {
    const session = makeSession();
    // Only one turn that cannot be compacted (recent tail = 2, group size = 3 → nothing to group)
    addHeavyTurn(session, 4000);

    const summarizer = makeSummarizer();
    const pinPolicy = createDefaultPinPolicy();
    const cw = new ContextWindow({
      provider: fakeProvider,
      model: "test",
      summarizer,
      budgetTokens: 50,
      keepRecentTurns: 2,
      groupSize: 3,
      pinPolicy,
      elisionPolicy: createDefaultElisionPolicy({ minElideChars: 50_000 }),
      selectStrategy: selectHierarchical({
        budgetTokens: 50,
        keepRecentTurns: 2,
        pinPolicy,
        elisionPolicy: createDefaultElisionPolicy({ minElideChars: 50_000 }),
        estimator: createTokenEstimator(),
      }),
    });
    const result = await cw.build(session, { skills: new SkillsModel() });

    expect(result.events.some((e) => e.type === "context-thrash")).toBe(true);
    expect(result.stats.compacted).toBe(true);
  });
});

describe("ContextWindow.build — system prompt assembly", () => {
  it("returns template alone when no skills are available", async () => {
    const session = makeSession();
    addTurnPair(session, "hi", "hello");

    const cw = new ContextWindow({ provider: fakeProvider, model: "test" });
    const result = await cw.build(session, { skills: new SkillsModel() });

    expect(result.system).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(result.system).not.toContain(SKILLS_INSTRUCTION);
    expect(result.system).not.toContain("## Active Skills");
  });

  it("includes SKILLS_INSTRUCTION when skills are available", async () => {
    const session = makeSession();
    addTurnPair(session, "hi", "hello");

    const skills = new SkillsModel();
    skills.register({ name: "read-csv", description: "csv tool", content: "use this skill" });

    const cw = new ContextWindow({ provider: fakeProvider, model: "test" });
    const result = await cw.build(session, { skills });

    expect(result.system).toContain(SKILLS_INSTRUCTION);
    expect(result.system).not.toContain("## Active Skills");
  });

  it("includes active skill blocks when skills are selected", async () => {
    const session = makeSession();
    addTurnPair(session, "hi", "hello");

    const skills = new SkillsModel();
    skills.register({ name: "read-csv", description: "csv tool", content: "csv body" });
    skills.register({ name: "stats", description: "stats tool", content: "stats body" });
    skills.select(["read-csv"]);

    const cw = new ContextWindow({ provider: fakeProvider, model: "test" });
    const result = await cw.build(session, { skills });

    expect(result.system).toContain(SKILLS_INSTRUCTION);
    expect(result.system).toContain("## Active Skills");
    expect(result.system).toContain("### read-csv");
    expect(result.system).toContain("csv body");
    expect(result.system).not.toContain("### stats");
  });

  it("respects a per-construction systemPromptTemplate override", async () => {
    const session = makeSession();
    addTurnPair(session, "hi", "hello");

    const cw = new ContextWindow({
      provider: fakeProvider,
      model: "test",
      systemPromptTemplate: "Custom directive only.",
    });
    const result = await cw.build(session, { skills: new SkillsModel() });

    expect(result.system).toBe("Custom directive only.");
  });
});

describe("ContextWindow.build — idempotence", () => {
  it("under-budget session: two consecutive builds produce identical messages and zero events", async () => {
    const session = makeSession();
    addTurnPair(session, "Hi", "Hello");
    addTurnPair(session, "How?", "Fine");

    const cw = new ContextWindow({ provider: fakeProvider, model: "test" });
    const a = await cw.build(session, { skills: new SkillsModel() });
    const b = await cw.build(session, { skills: new SkillsModel() });

    expect(b.messages).toEqual(a.messages);
    expect(a.events).toEqual([]);
    expect(b.events).toEqual([]);
    expect(b.stats.messageCount).toBe(a.stats.messageCount);
  });

  it("under-budget session: second build with compaction configured does not mutate the tree", async () => {
    const session = makeSession();
    addTurnPair(session, "Hi", "Hello");

    const summarizer = makeSummarizer();
    const pinPolicy = createDefaultPinPolicy();
    const cw = new ContextWindow({
      provider: fakeProvider,
      model: "test",
      summarizer,
      budgetTokens: 100_000,
      keepRecentTurns: 2,
      groupSize: 3,
      pinPolicy,
      selectStrategy: selectHierarchical({
        budgetTokens: 100_000,
        keepRecentTurns: 2,
        pinPolicy,
        elisionPolicy: createDefaultElisionPolicy(),
        estimator: createTokenEstimator(),
      }),
    });
    await cw.build(session, { skills: new SkillsModel() });
    const childCount = session.children.length;
    await cw.build(session, { skills: new SkillsModel() });
    expect(session.children.length).toBe(childCount);
  });
});
