import type { ProviderV3 } from "@ai-sdk/provider";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContextWindow } from "../../src/context/context-window.js";
import { TurnDriver } from "../../src/runtime/turn-driver.js";
import type { InboxMessage } from "../../src/state/inbox.js";
import {
  createAgentNodeFactory,
  NodeType,
  type Session,
  SkillsModel,
  ToolRegistry,
} from "../../src/state/index.js";
import type { LogMessage } from "../../src/state/log-message.js";
import type { Turn } from "../../src/state/turn.js";

// Mock streamText so we can script stream events per scenario.
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    streamText: vi.fn(),
    generateText: vi.fn(async () => ({ text: "" })),
  };
});

import { streamText } from "ai";

const mockStreamText = streamText as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockStreamText.mockReset();
  mockStreamText.mockImplementation(() => ({ fullStream: emptyStream() }));
});

async function* emptyStream(): AsyncGenerator<{ type: string }> {
  // no parts
}

function scriptStream(
  parts: Array<Record<string, unknown>>,
): AsyncGenerator<{ type: string; [k: string]: unknown }> {
  return (async function* () {
    for (const p of parts) yield p as { type: string };
  })();
}

function makeState(): Session {
  const factory = createAgentNodeFactory();
  return factory({ type: NodeType.session }) as Session;
}

function makeDriver(overrides?: {
  skills?: SkillsModel;
  tools?: ToolRegistry;
  contextWindow?: ContextWindow;
  maxSteps?: number;
}): TurnDriver {
  const provider = { languageModel: vi.fn() } as unknown as ProviderV3;
  const tools = overrides?.tools ?? new ToolRegistry();
  const skills = overrides?.skills ?? new SkillsModel();
  const contextWindow =
    overrides?.contextWindow ??
    new ContextWindow({ provider, model: "test", systemPromptTemplate: "Base" });
  return new TurnDriver({
    provider,
    model: "test",
    contextWindow,
    tools,
    skills,
    maxSteps: overrides?.maxSteps,
  });
}

async function collect(gen: AsyncGenerator<LogMessage>): Promise<LogMessage[]> {
  const messages: LogMessage[] = [];
  for await (const msg of gen) messages.push(msg);
  return messages;
}

const msg = (text: string): InboxMessage => ({ role: "user", text });

describe("TurnDriver.drive — turn lifecycle", () => {
  it("appends exactly one Turn per call with the user message text", async () => {
    const state = makeState();
    const driver = makeDriver();

    await collect(driver.drive(state, msg("hello")));
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]?.messages[0]?.text).toBe("hello");
  });

  it("two consecutive drive calls produce two turns", async () => {
    const state = makeState();
    const driver = makeDriver();

    await collect(driver.drive(state, msg("first")));
    await collect(driver.drive(state, msg("second")));
    expect(state.turns).toHaveLength(2);
    expect(state.turns[1]?.messages[0]?.text).toBe("second");
  });
});

describe("TurnDriver.drive — ContextWindow event forwarding", () => {
  it("forwards events returned by ContextWindow.build before stream output", async () => {
    const state = makeState();
    const provider = { languageModel: vi.fn() } as unknown as ProviderV3;
    const contextWindow = new ContextWindow({ provider, model: "test" });
    vi.spyOn(contextWindow, "build").mockResolvedValue({
      system: "x",
      messages: [],
      events: [
        {
          type: "context-thrash",
          turnId: "",
          stamp: "s1",
          budget: 100,
          estimated: 999,
        },
      ],
      stats: { messageCount: 0, estimatedTokens: 0, compacted: true },
    });
    mockStreamText.mockImplementation(() => ({
      fullStream: scriptStream([{ type: "finish-step", finishReason: "stop" }]),
    }));

    const driver = makeDriver({ contextWindow });
    const logs = await collect(driver.drive(state, msg("hi")));

    const thrash = logs.findIndex((l) => l.type === "context-thrash");
    const finish = logs.findIndex((l) => l.type === "turn-finish");
    expect(thrash).toBeGreaterThanOrEqual(0);
    expect(finish).toBeGreaterThan(thrash);
  });
});

describe("TurnDriver.drive — finishReason classification", () => {
  async function runOnce(
    parts: Array<Record<string, unknown>>,
  ): Promise<{ state: Session; logs: LogMessage[] }> {
    const state = makeState();
    mockStreamText.mockImplementation(() => ({ fullStream: scriptStream(parts) }));
    const driver = makeDriver();
    const logs = await collect(driver.drive(state, msg("hi")));
    return { state, logs };
  }

  it("classifies 'stop' with content as ok", async () => {
    const { logs, state } = await runOnce([
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", text: "hello" },
      { type: "text-end", id: "t1" },
      { type: "finish-step", finishReason: "stop" },
    ]);
    expect(logs.find((l) => l.type === "turn-finish")).toMatchObject({
      kind: "ok",
      finishReason: "stop",
    });
    expect(state.turns[0]?.stopReason).toBe("stop");
  });

  it("classifies 'stop' with no content as empty", async () => {
    const { logs } = await runOnce([{ type: "finish-step", finishReason: "stop" }]);
    expect(logs.find((l) => l.type === "turn-finish")).toMatchObject({
      kind: "empty",
      finishReason: "stop",
    });
  });

  it("classifies 'length' as length", async () => {
    const { logs } = await runOnce([
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", text: "partial" },
      { type: "finish-step", finishReason: "length" },
    ]);
    expect(logs.find((l) => l.type === "turn-finish")).toMatchObject({
      kind: "length",
      finishReason: "length",
    });
  });

  it("classifies 'tool-calls' as step-limit", async () => {
    const { logs } = await runOnce([{ type: "finish-step", finishReason: "tool-calls" }]);
    expect(logs.find((l) => l.type === "turn-finish")).toMatchObject({
      kind: "step-limit",
      finishReason: "tool-calls",
    });
  });

  it("classifies 'content-filter' as filtered", async () => {
    const { logs } = await runOnce([{ type: "finish-step", finishReason: "content-filter" }]);
    expect(logs.find((l) => l.type === "turn-finish")).toMatchObject({ kind: "filtered" });
  });

  it("classifies unknown finishReason as unknown", async () => {
    const { logs } = await runOnce([{ type: "finish-step", finishReason: "weirdness" }]);
    expect(logs.find((l) => l.type === "turn-finish")).toMatchObject({
      kind: "unknown",
      finishReason: "weirdness",
    });
  });

  it("classifies stream with no finish-step as empty", async () => {
    const { logs } = await runOnce([]);
    expect(logs.find((l) => l.type === "turn-finish")).toMatchObject({ kind: "empty" });
  });
});

describe("TurnDriver.drive — error paths", () => {
  it("streamText throwing yields exactly one error LogMessage then turn-finish error", async () => {
    const state = makeState();
    mockStreamText.mockImplementation(() => {
      throw new Error("network down");
    });
    const driver = makeDriver();

    const logs = await collect(driver.drive(state, msg("hi")));
    expect(logs.filter((l) => l.type === "error")).toHaveLength(1);
    expect(logs.find((l) => l.type === "error")).toMatchObject({ message: "network down" });
    expect(logs.find((l) => l.type === "turn-finish")).toMatchObject({ kind: "error" });

    const errorNode = state.turns[0]?.children.find((c) => c.type === NodeType.error);
    expect(errorNode?.content).toBe("network down");
    expect(state.turns).toHaveLength(1);
  });

  it("mid-stream exception is captured once per turn", async () => {
    const state = makeState();
    mockStreamText.mockImplementation(() => ({
      fullStream: (async function* () {
        yield { type: "text-start", id: "t1" };
        yield { type: "text-delta", id: "t1", text: "partial" };
        throw new Error("stream died");
      })(),
    }));
    const driver = makeDriver();

    const logs = await collect(driver.drive(state, msg("hi")));
    expect(logs.filter((l) => l.type === "error")).toHaveLength(1);
    expect(logs.filter((l) => l.type === "turn-finish")).toHaveLength(1);
    expect(logs.find((l) => l.type === "turn-finish")).toMatchObject({ kind: "error" });
  });

  it("clean abort yields turn-finish aborted with no error node", async () => {
    const state = makeState();
    const abort = new AbortController();
    mockStreamText.mockImplementation(() => ({
      fullStream: (async function* () {
        yield { type: "text-start", id: "t1" };
        abort.abort();
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      })(),
    }));
    const driver = makeDriver();

    const logs = await collect(driver.drive(state, msg("hi"), abort.signal));
    expect(logs.find((l) => l.type === "turn-finish")).toMatchObject({ kind: "aborted" });
    expect(state.turns[0]?.children.some((c) => c.type === NodeType.error)).toBe(false);
  });
});

describe("TurnDriver.drive — tool errors", () => {
  it("yields a tool-error log when the SDK emits tool-error", async () => {
    const state = makeState();
    mockStreamText.mockImplementation(() => ({
      fullStream: scriptStream([
        { type: "tool-call", toolCallId: "c1", toolName: "read", input: {} },
        {
          type: "tool-error",
          toolCallId: "c1",
          toolName: "read",
          error: new Error("permission denied"),
        },
        { type: "finish-step", finishReason: "stop" },
      ]),
    }));
    const driver = makeDriver();

    const logs = await collect(driver.drive(state, msg("hi")));
    expect(logs.find((l) => l.type === "tool-error")).toMatchObject({
      toolCallId: "c1",
      toolName: "read",
      message: "permission denied",
    });
    const turn = state.turns[0] as Turn;
    expect(turn.toolCalls[0]?.isError).toBe(true);
    expect(turn.toolCalls[0]?.result).toBe("permission denied");
  });
});

describe("TurnDriver.drive — first-turn skill selection", () => {
  it("does not run when no skills are available", async () => {
    const state = makeState();
    const skills = new SkillsModel();
    const driver = makeDriver({ skills });

    // No spy on private method needed — just verify no extra logs appear.
    const logs = await collect(driver.drive(state, msg("hi")));
    const skillLog = logs.find(
      (l) =>
        l.type === "step-finish" &&
        (l as { finishReason?: string }).finishReason?.startsWith("skills:"),
    );
    expect(skillLog).toBeUndefined();
  });

  it("runs once on the first turn when skills are available; not on subsequent turns", async () => {
    const state = makeState();
    const skills = new SkillsModel();
    skills.register({ name: "test-skill", description: "Test", content: "C" });

    const driver = makeDriver({ skills });
    const selectSpy = vi
      .spyOn(
        driver as unknown as { selectSkillsForFirstTurn: () => AsyncGenerator },
        "selectSkillsForFirstTurn",
      )
      .mockImplementation(async function* () {});

    await collect(driver.drive(state, msg("first")));
    await collect(driver.drive(state, msg("second")));
    expect(selectSpy).toHaveBeenCalledTimes(1);
  });
});
