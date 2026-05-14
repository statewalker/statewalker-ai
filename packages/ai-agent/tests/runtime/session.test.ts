import type { ProviderV3 } from "@ai-sdk/provider";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../../src/runtime/agent-runtime.js";
import type { LogMessage } from "../../src/state/log-message.js";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    streamText: vi.fn(),
    generateText: vi.fn(async () => ({ text: "generated title" })),
  };
});

import { generateText, streamText } from "ai";

const mockStreamText = streamText as unknown as ReturnType<typeof vi.fn>;
const mockGenerateText = generateText as unknown as ReturnType<typeof vi.fn>;

function mockProvider(): ProviderV3 {
  return { languageModel: vi.fn() } as unknown as ProviderV3;
}

async function buildSession(opts?: { skillsBefore?: () => void }) {
  const files = new MemFilesApi();
  const runtime = new AgentRuntime({ files }).addModelProvider(mockProvider());
  await runtime.build();
  opts?.skillsBefore?.();
  const agent = runtime.createAgent({ name: "test", defaultModel: "test" });
  return agent.createSession({ title: undefined });
}

beforeEach(() => {
  mockStreamText.mockReset();
  mockStreamText.mockImplementation(() => ({
    fullStream: (async function* () {
      yield { type: "finish-step", finishReason: "stop" };
    })(),
  }));
  mockGenerateText.mockReset();
  mockGenerateText.mockImplementation(async () => ({ text: "generated title" }));
});

async function collect(gen: AsyncGenerator<LogMessage>): Promise<LogMessage[]> {
  const messages: LogMessage[] = [];
  for await (const msg of gen) messages.push(msg);
  return messages;
}

describe("Session.run — inbox loop", () => {
  it("terminates immediately when signal is aborted before any message arrives", async () => {
    const session = await buildSession();
    const abort = new AbortController();
    abort.abort();
    const messages = await collect(session.run(abort.signal));
    expect(messages).toHaveLength(0);
    expect(session.state.turns).toHaveLength(0);
  });

  it("processes multiple inbox messages, one Turn each", async () => {
    const session = await buildSession();
    session.send("first");
    session.send("second");
    session.send("third");

    const abort = new AbortController();
    setTimeout(() => abort.abort(), 100);
    await collect(session.run(abort.signal));

    expect(session.state.turns).toHaveLength(3);
    expect(session.state.turns[0]?.messages[0]?.text).toBe("first");
    expect(session.state.turns[2]?.messages[0]?.text).toBe("third");
  });
});

describe("Session.run — first-turn title generation", () => {
  it("sets state.title before yielding the first turn-finish event", async () => {
    const session = await buildSession();
    session.send("hello world");

    const observations: Array<{ at: string; title: string | undefined }> = [];
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 100);

    for await (const ev of session.run(abort.signal)) {
      observations.push({ at: ev.type, title: session.state.title });
    }

    const finishObs = observations.find((o) => o.at === "turn-finish");
    expect(finishObs?.title).toBe("generated title");
    expect(session.state.title).toBe("generated title");
  });

  it("does not regenerate the title on subsequent turns", async () => {
    const session = await buildSession();
    session.send("first message");
    session.send("second message");

    const abort = new AbortController();
    setTimeout(() => abort.abort(), 100);
    await collect(session.run(abort.signal));

    // generateText is only called once across both turns
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });

  it("does not override a pre-existing title", async () => {
    const files = new MemFilesApi();
    const runtime = new AgentRuntime({ files }).addModelProvider(mockProvider());
    await runtime.build();
    const agent = runtime.createAgent({ name: "test", defaultModel: "test" });
    const session = agent.createSession({ title: "preset title" });
    session.send("hi");

    const abort = new AbortController();
    setTimeout(() => abort.abort(), 100);
    await collect(session.run(abort.signal));

    expect(session.state.title).toBe("preset title");
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("swallows generateText errors without disrupting the turn", async () => {
    mockGenerateText.mockImplementationOnce(() => {
      throw new Error("title generation failed");
    });
    const session = await buildSession();
    session.send("hi");

    const abort = new AbortController();
    setTimeout(() => abort.abort(), 100);
    const logs = await collect(session.run(abort.signal));

    expect(logs.find((l) => l.type === "turn-finish")).toBeDefined();
    expect(session.state.title).toBeUndefined();
  });
});

describe("Session — built-in tools registration", () => {
  it("registers list_tools eagerly at construction (no skills)", async () => {
    const session = await buildSession();
    expect(session.tools.toToolSet()).toHaveProperty("list_tools");
    expect(session.tools.toToolSet()).not.toHaveProperty("list_skills");
    expect(session.tools.toToolSet()).not.toHaveProperty("use_skills");
  });

  it("registers list_skills + use_skills when the runtime has skills", async () => {
    const files = new MemFilesApi();
    const runtime = new AgentRuntime({ files })
      .addModelProvider(mockProvider())
      .addSkills({ name: "s1", description: "S1", content: "C1" });
    await runtime.build();
    const agent = runtime.createAgent({ name: "test", defaultModel: "test" });
    const session = agent.createSession();

    expect(session.tools.toToolSet()).toHaveProperty("list_tools");
    expect(session.tools.toToolSet()).toHaveProperty("list_skills");
    expect(session.tools.toToolSet()).toHaveProperty("use_skills");
  });
});

describe("Session.run — close semantics", () => {
  it("throws if run() is called after close()", async () => {
    const session = await buildSession();
    await session.close();
    const gen = session.run();
    await expect(gen.next()).rejects.toThrow(/closed/);
  });

  it("close() is idempotent", async () => {
    const session = await buildSession();
    await session.close();
    await expect(session.close()).resolves.toBeUndefined();
  });
});
