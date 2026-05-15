import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultElisionPolicy } from "../../src/context/tool-elision.js";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: vi.fn() };
});

import { generateText } from "ai";
import {
  createHierarchicalSummarizer,
  renderDepth1Input,
  renderDepthKInput,
} from "../../src/context/hierarchical-summarizer.js";
import {
  createAgentNodeFactory,
  NodeType,
  type SessionState,
  type TurnGroup,
} from "../../src/state/index.js";

const mockGenerate = generateText as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockGenerate.mockReset();
});

function makeSession(): SessionState {
  const factory = createAgentNodeFactory();
  return factory({ type: NodeType.session }) as SessionState;
}

describe("renderDepth1Input", () => {
  it("includes turn id markers and user/assistant/tool lines", () => {
    const session = makeSession();
    const t1 = session.addTurn();
    t1.addUserMessage("please list files");
    t1.addAgentMessage().appendDelta("sure");
    const tc = t1.addToolCall("c1", "list_files", { path: "/" });
    tc.addResponse("a\nb\nc");

    const out = renderDepth1Input([t1], createDefaultElisionPolicy());
    expect(out).toContain(`[T${t1.id}]`);
    expect(out).toContain("User: please list files");
    expect(out).toContain("Assistant: sure");
    expect(out).toContain("Tool(list_files)");
  });

  it("elides oversized tool responses in the rendered input", () => {
    const session = makeSession();
    const turn = session.addTurn();
    const tc = turn.addToolCall("c1", "anything", { path: "/" });
    tc.addResponse("x".repeat(20_000));

    const out = renderDepth1Input([turn], createDefaultElisionPolicy({ minElideChars: 1000 }));
    expect(out).not.toContain("x".repeat(20_000));
    expect(out).toMatch(/…elided|result elided/);
  });
});

describe("renderDepthKInput", () => {
  it("includes group id markers and copies summary text", () => {
    const session = makeSession();
    const g1 = session.addChild({
      type: NodeType.turnGroup,
    }) as TurnGroup;
    g1.summaryText = "summary of earlier turns";
    g1.depth = 1;
    const g2 = session.addChild({
      type: NodeType.turnGroup,
    }) as TurnGroup;
    g2.summaryText = "later summary";
    g2.depth = 1;

    const out = renderDepthKInput([g1, g2], 0);
    expect(out).toContain(`[G${g1.id}] depth=1`);
    expect(out).toContain("summary of earlier turns");
    expect(out).toContain(`[G${g2.id}]`);
    expect(out).toContain("later summary");
  });

  it("includes one peek per child when spotPeekPerChild > 0", () => {
    const session = makeSession();
    const g = session.addChild({ type: NodeType.turnGroup }) as TurnGroup;
    g.summaryText = "s";
    const turnA = g.addChild({ type: NodeType.turn });
    turnA.addChild({ type: NodeType.userMessage, content: "first user msg" });
    const turnB = g.addChild({ type: NodeType.turn });
    turnB.addChild({ type: NodeType.userMessage, content: "second user msg" });

    const out = renderDepthKInput([g], 1);
    expect(out).toContain("peek[");
    expect(out).toContain("first user msg");
    expect(out).not.toContain("second user msg");
  });
});

describe("createHierarchicalSummarizer", () => {
  it("returns content for short input", async () => {
    mockGenerate.mockResolvedValue({
      text: JSON.stringify({ content: "summary X", sections: null }),
    });
    const summ = createHierarchicalSummarizer({
      model: "m" as unknown as never,
    });
    const session = makeSession();
    const t = session.addTurn();
    t.addUserMessage("hi");

    const out = await summ.summarize({ kind: "depth-1", turns: [t] });
    expect(out.content).toBe("summary X");
    expect(out.sections).toBeUndefined();
  });

  it("returns sections when the model provides them", async () => {
    mockGenerate.mockResolvedValue({
      text: JSON.stringify({
        content: "summary",
        sections: [{ title: "Decisions", body: "chose X", refs: ["01", "02"] }],
      }),
    });
    const summ = createHierarchicalSummarizer({
      model: "m" as unknown as never,
    });
    const session = makeSession();
    const t = session.addTurn();
    t.addUserMessage("…");

    const out = await summ.summarize({ kind: "depth-1", turns: [t] });
    expect(out.sections).toEqual([{ title: "Decisions", body: "chose X", refs: ["01", "02"] }]);
  });

  it("drops sections missing title/body/refs", async () => {
    mockGenerate.mockResolvedValue({
      text: JSON.stringify({
        content: "summary",
        sections: [
          { title: "ok", body: "has both", refs: ["x"] },
          { title: "", body: "no title", refs: ["y"] },
          { title: "no refs", body: "body", refs: [] },
        ],
      }),
    });
    const summ = createHierarchicalSummarizer({
      model: "m" as unknown as never,
    });
    const session = makeSession();
    const t = session.addTurn();
    t.addUserMessage("…");

    const out = await summ.summarize({ kind: "depth-1", turns: [t] });
    expect(out.sections).toEqual([{ title: "ok", body: "has both", refs: ["x"] }]);
  });

  it("tolerates JSON wrapped in a code fence", async () => {
    mockGenerate.mockResolvedValue({
      text:
        "Here's the summary:\n```json\n" +
        JSON.stringify({ content: "fenced summary", sections: null }) +
        "\n```",
    });
    const summ = createHierarchicalSummarizer({
      model: "m" as unknown as never,
    });
    const session = makeSession();
    const t = session.addTurn();
    t.addUserMessage("…");

    const out = await summ.summarize({ kind: "depth-1", turns: [t] });
    expect(out.content).toBe("fenced summary");
  });

  it("retries once when first response is empty, then throws on second fail", async () => {
    mockGenerate.mockResolvedValueOnce({ text: "" }).mockResolvedValueOnce({ text: "" });
    const summ = createHierarchicalSummarizer({
      model: "m" as unknown as never,
    });
    const session = makeSession();
    const t = session.addTurn();
    t.addUserMessage("…");

    await expect(summ.summarize({ kind: "depth-1", turns: [t] })).rejects.toThrow(
      /empty or unparsable output/,
    );
    expect(mockGenerate).toHaveBeenCalledTimes(2);
  });

  it("routes depth-1 and depth-k to their respective models", async () => {
    mockGenerate.mockResolvedValue({
      text: JSON.stringify({ content: "ok" }),
    });
    const depth1Model = "m1" as unknown as never;
    const depthKModel = "mK" as unknown as never;
    const summ = createHierarchicalSummarizer({
      model: { depth1: depth1Model, depthK: depthKModel },
    });
    const session = makeSession();
    const t = session.addTurn();
    t.addUserMessage("…");
    const g = session.addChild({ type: NodeType.turnGroup }) as TurnGroup;
    g.summaryText = "s";

    await summ.summarize({ kind: "depth-1", turns: [t] });
    const firstCallModel = mockGenerate.mock.calls[0]?.[0]?.model;
    expect(firstCallModel).toBe(depth1Model);

    await summ.summarize({ kind: "depth-k", children: [g], depth: 2 });
    const secondCallModel = mockGenerate.mock.calls[1]?.[0]?.model;
    expect(secondCallModel).toBe(depthKModel);
  });
});
