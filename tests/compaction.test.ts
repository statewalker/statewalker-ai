import { describe, expect, it, vi } from "vitest";
import type { ContentSummarizer } from "../src/context/content-summarizer.js";
import { selectWithCompaction } from "../src/context/select-messages.js";
import { createAgentNodeFactory, type Session } from "../src/state/index.js";

function makeSession(): Session {
  const factory = createAgentNodeFactory();
  return factory({ type: "session" }) as Session;
}

function addTurnPair(session: Session, userText: string, agentText: string) {
  const turn = session.addTurn();
  turn.addUserMessage(userText);
  turn.addAgentMessage().appendDelta(agentText);
}

function mockSummarizer(result = "summarized"): ContentSummarizer {
  return {
    summarize: vi.fn().mockResolvedValue(result),
  };
}

describe("selectWithCompaction", () => {
  it("yields all turns verbatim when count <= maxRecentTurns", async () => {
    const session = makeSession();
    addTurnPair(session, "Hi", "Hello");
    addTurnPair(session, "How?", "Fine");

    const summarizer = mockSummarizer();
    const strategy = selectWithCompaction({
      summarizer,
      maxRecentTurns: 4,
    });

    const msgs = await strategy(session);
    expect(summarizer.summarize).not.toHaveBeenCalled();
    expect(msgs).toHaveLength(4);
  });

  it("summarizes older turns when count > maxRecentTurns", async () => {
    const session = makeSession();
    for (let i = 0; i < 6; i++) {
      addTurnPair(session, `Q${i}`, `A${i}`);
    }

    const summarizer = mockSummarizer("old stuff summarized");
    const strategy = selectWithCompaction({
      summarizer,
      maxRecentTurns: 2,
    });

    const msgs = await strategy(session);
    // Each older turn is summarized individually
    expect(summarizer.summarize).toHaveBeenCalledTimes(4);

    expect(msgs[0]).toEqual({
      role: "user",
      content:
        "[Summary of earlier conversation]\nold stuff summarized\nold stuff summarized\nold stuff summarized\nold stuff summarized",
    });

    // 1 summary + 2 recent turns * 2 messages = 5
    expect(msgs).toHaveLength(5);
  });

  it("caches summaries on turn nodes", async () => {
    const session = makeSession();
    for (let i = 0; i < 4; i++) {
      addTurnPair(session, `Q${i}`, `A${i}`);
    }

    const summarizer = mockSummarizer("cached");
    const strategy = selectWithCompaction({
      summarizer,
      maxRecentTurns: 2,
    });

    // First call: summarizer invoked for 2 older turns
    await strategy(session);
    expect(summarizer.summarize).toHaveBeenCalledTimes(2);

    // Second call: summaries cached, summarizer not called again
    (summarizer.summarize as ReturnType<typeof vi.fn>).mockClear();
    await strategy(session);
    expect(summarizer.summarize).not.toHaveBeenCalled();

    // Verify summaries stored on turn nodes
    expect(session.turns[0]?.props.summary).toBe("cached");
    expect(session.turns[1]?.props.summary).toBe("cached");
  });

  it("defaults maxRecentTurns to 4", async () => {
    const session = makeSession();
    for (let i = 0; i < 5; i++) {
      addTurnPair(session, `Q${i}`, `A${i}`);
    }

    const summarizer = mockSummarizer();
    const strategy = selectWithCompaction({ summarizer });

    await strategy(session);
    // 5 turns, default 4 recent → 1 summarized
    expect(summarizer.summarize).toHaveBeenCalledTimes(1);
  });
});
