import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContextCompactor } from "../../src/context/context-compactor.js";
import type { HierarchicalSummarizer } from "../../src/context/hierarchical-summarizer.js";
import { createDefaultPinPolicy } from "../../src/context/pin-policy.js";
import { selectHierarchical } from "../../src/context/select-hierarchical.js";
import { createTokenEstimator } from "../../src/context/token-estimator.js";
import { createDefaultElisionPolicy } from "../../src/context/tool-elision.js";
import { AgentController } from "../../src/controller/agent-controller.js";
import { Inbox } from "../../src/state/inbox.js";
import {
  createAgentNodeFactory,
  NodeType,
  type Session,
  type TurnGroup,
} from "../../src/state/index.js";
import { SkillsModel } from "../../src/state/skills-model.js";
import { ToolRegistry } from "../../src/state/tool-registry.js";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    streamText: vi.fn(),
    generateText: vi.fn(async () => ({ text: "ok" })),
  };
});

import { streamText } from "ai";

const mockStreamText = streamText as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockStreamText.mockReset();
  mockStreamText.mockImplementation(() => ({
    fullStream: (async function* () {
      // Emit a trivial step-finish so the turn records a stopReason.
      yield {
        type: "finish-step",
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
      yield { type: "finish", totalUsage: { inputTokens: 0, outputTokens: 0 } };
    })(),
  }));
});

function makeSession(): Session {
  const factory = createAgentNodeFactory();
  return factory({ type: NodeType.session }) as Session;
}

function stubSummarizer(): HierarchicalSummarizer {
  const summarize = vi.fn(async () => ({
    content: "synthetic summary",
  }));
  return { summarize };
}

describe("AgentController with budget compaction", () => {
  it("triggers at least one group formation as turns accumulate heavy content", async () => {
    const session = makeSession();
    // Seed the session with 8 heavy pre-existing turns so the compactor
    // has work to do on the first real inbox message.
    for (let i = 0; i < 8; i++) {
      const t = session.addTurn();
      t.addUserMessage(`prior user ${i}`);
      const m = t.addAgentMessage();
      m.appendDelta("a".repeat(800));
    }

    const estimator = createTokenEstimator();
    const pinPolicy = createDefaultPinPolicy();
    const elisionPolicy = createDefaultElisionPolicy();
    const summarizer = stubSummarizer();

    const controller = new AgentController({
      provider: { languageModel: vi.fn() } as never,
      model: "test",
      systemPrompt: "x",
      session,
      inbox: new Inbox(),
      tools: new ToolRegistry(),
      skills: new SkillsModel(),
      compactor: new ContextCompactor(),
      compactOptions: {
        budgetTokens: 300,
        summarizer,
        estimator,
        pinPolicy,
        elisionPolicy,
        keepRecentTurns: 2,
        groupSize: 4,
        depthPromoteThreshold: 4,
      },
      select: selectHierarchical({
        budgetTokens: 300,
        keepRecentTurns: 2,
        pinPolicy,
        elisionPolicy,
        estimator,
      }),
    });

    // Push one user message; the controller should compact before streaming.
    controller.inbox.push({ role: "user", text: "do thing" });
    const abort = new AbortController();

    const events = [];
    for await (const ev of controller.run(abort.signal)) {
      events.push(ev);
      if (ev.type === "turn-finish") abort.abort();
    }

    // At least one TurnGroup must have been created in the session root.
    const groups = session.children.filter(
      (c) => c.type === NodeType.turnGroup,
    ) as TurnGroup[];
    expect(groups.length).toBeGreaterThanOrEqual(1);
    expect((summarizer.summarize as ReturnType<typeof vi.fn>).mock.calls.length)
      .toBeGreaterThanOrEqual(1);
    // Controller loop did not crash — at least one turn-finish was yielded.
    expect(events.some((e) => e.type === "turn-finish")).toBe(true);
  });
});
