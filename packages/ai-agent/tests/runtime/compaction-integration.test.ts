import type { ProviderV3 } from "@ai-sdk/provider";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContextWindow } from "../../src/context/context-window.js";
import type { HierarchicalSummarizer } from "../../src/context/hierarchical-summarizer.js";
import { createDefaultPinPolicy } from "../../src/context/pin-policy.js";
import { selectHierarchical } from "../../src/context/select-hierarchical.js";
import { createTokenEstimator } from "../../src/context/token-estimator.js";
import { createDefaultElisionPolicy } from "../../src/context/tool-elision.js";
import { TurnDriver } from "../../src/runtime/turn-driver.js";
import {
  createAgentNodeFactory,
  NodeType,
  type Session,
  SkillsModel,
  ToolRegistry,
  type TurnGroup,
} from "../../src/state/index.js";

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
      yield {
        type: "finish-step",
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
      yield { type: "finish", totalUsage: { inputTokens: 0, outputTokens: 0 } };
    })(),
  }));
});

function makeState(): Session {
  const factory = createAgentNodeFactory();
  return factory({ type: NodeType.session }) as Session;
}

function stubSummarizer(): HierarchicalSummarizer {
  const summarize = vi.fn(async () => ({ content: "synthetic summary" }));
  return { summarize };
}

describe("TurnDriver with budget compaction", () => {
  it("triggers at least one group formation as turns accumulate heavy content", async () => {
    const state = makeState();
    // Seed with 8 heavy pre-existing turns so the compactor has work on
    // the first driven turn.
    for (let i = 0; i < 8; i++) {
      const t = state.addTurn();
      t.addUserMessage(`prior user ${i}`);
      t.addAgentMessage().appendDelta("a".repeat(800));
    }

    const estimator = createTokenEstimator();
    const pinPolicy = createDefaultPinPolicy();
    const elisionPolicy = createDefaultElisionPolicy();
    const summarizer = stubSummarizer();

    const provider = { languageModel: vi.fn() } as unknown as ProviderV3;
    const contextWindow = new ContextWindow({
      provider,
      model: "test",
      systemPromptTemplate: "x",
      summarizer,
      estimator,
      pinPolicy,
      elisionPolicy,
      budgetTokens: 300,
      keepRecentTurns: 2,
      groupSize: 4,
      depthPromoteThreshold: 4,
      selectStrategy: selectHierarchical({
        budgetTokens: 300,
        keepRecentTurns: 2,
        pinPolicy,
        elisionPolicy,
        estimator,
      }),
    });
    const driver = new TurnDriver({
      provider,
      model: "test",
      contextWindow,
      tools: new ToolRegistry(),
      skills: new SkillsModel(),
    });

    const events = [];
    for await (const ev of driver.drive(state, { role: "user", text: "do thing" })) {
      events.push(ev);
    }

    const groups = state.children.filter((c) => c.type === NodeType.turnGroup) as TurnGroup[];
    expect(groups.length).toBeGreaterThanOrEqual(1);
    expect(
      (summarizer.summarize as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.type === "turn-finish")).toBe(true);
  });
});
