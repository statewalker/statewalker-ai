import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentController } from "../../src/controller/agent-controller.js";
import { Inbox } from "../../src/state/inbox.js";
import { createAgentNodeFactory, type Session } from "../../src/state/index.js";
import type { LogMessage } from "../../src/state/log-message.js";
import { NodeType } from "../../src/state/node-types.js";
import { SkillsModel } from "../../src/state/skills-model.js";
import { ToolRegistry } from "../../src/state/tool-registry.js";
import type { Turn } from "../../src/state/turn.js";

// Mock streamText so edge-case tests can script stream events.
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
  (streamText as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    () => ({ fullStream: emptyStream() }),
  );
});

function makeSession(): Session {
  const factory = createAgentNodeFactory();
  return factory({ type: "session" }) as Session;
}

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

function mockStreamTurn(controller: AgentController) {
  return vi
    .spyOn(
      controller as unknown as { streamTurn: () => AsyncGenerator },
      "streamTurn",
    )
    .mockImplementation(async function* () {
      // no log messages
    });
}

function makeController(overrides?: {
  session?: Session;
  inbox?: Inbox;
  skills?: SkillsModel;
  tools?: ToolRegistry;
  systemPrompt?: string;
  maxSteps?: number;
}): AgentController {
  return new AgentController({
    session: overrides?.session ?? makeSession(),
    inbox: overrides?.inbox ?? new Inbox(),
    provider: { languageModel: vi.fn() } as never,
    model: "test",
    systemPrompt: overrides?.systemPrompt ?? "Base",
    tools: overrides?.tools ?? new ToolRegistry(),
    skills: overrides?.skills ?? new SkillsModel(),
    maxSteps: overrides?.maxSteps,
  });
}

async function collect(gen: AsyncGenerator<LogMessage>): Promise<LogMessage[]> {
  const messages: LogMessage[] = [];
  for await (const msg of gen) messages.push(msg);
  return messages;
}

describe("AgentController", () => {
  describe("buildSystemPrompt", () => {
    it("returns base prompt when no skills available", () => {
      const controller = makeController({ systemPrompt: "Base prompt" });
      expect(controller.buildSystemPrompt()).toBe("Base prompt");
    });

    it("appends skills instruction when skills are available", () => {
      const skills = new SkillsModel();
      skills.register({ name: "s1", description: "Skill 1", content: "C1" });
      const controller = makeController({ skills });
      const prompt = controller.buildSystemPrompt();
      expect(prompt).toContain("## Skills");
      expect(prompt).toContain("use_skills");
    });

    it("includes selected skill content", () => {
      const skills = new SkillsModel();
      skills.register({
        name: "file-ops",
        description: "File ops",
        content: "Read and write files.",
      });
      skills.select(["file-ops"]);
      const controller = makeController({ skills });
      const prompt = controller.buildSystemPrompt();
      expect(prompt).toContain("## Active Skills");
      expect(prompt).toContain("### file-ops");
      expect(prompt).toContain("Read and write files.");
    });
  });

  describe("run — turn persistence", () => {
    it("creates one Turn per inbox message and persists user text into it", async () => {
      const inbox = new Inbox();
      const session = makeSession();
      inbox.push({ role: "user", text: "msg1" });
      inbox.push({ role: "user", text: "msg2" });

      const controller = makeController({ session, inbox });
      mockStreamTurn(controller);

      const abort = new AbortController();
      setTimeout(() => abort.abort(), 50);
      await collect(controller.run(abort.signal));

      expect(session.turns).toHaveLength(2);
      expect(session.turns[0]?.messages[0]?.text).toBe("msg1");
      expect(session.turns[1]?.messages[0]?.text).toBe("msg2");
    });

    it("passes the same Turn to streamTurn and skill selection via #currentTurn", async () => {
      const inbox = new Inbox();
      const session = makeSession();
      const skills = new SkillsModel();
      skills.register({
        name: "test-skill",
        description: "Test",
        content: "C",
      });
      inbox.push({ role: "user", text: "hello" });

      const controller = makeController({ session, inbox, skills });

      const seenTurns: string[] = [];
      vi.spyOn(
        controller as unknown as {
          selectSkillsForFirstTurn: () => AsyncGenerator;
        },
        "selectSkillsForFirstTurn",
      ).mockImplementation(async function* (this: AgentController) {
        seenTurns.push(this.session.turns[0]?.id ?? "");
        yield* [];
      });
      vi.spyOn(
        controller as unknown as { streamTurn: () => AsyncGenerator },
        "streamTurn",
      ).mockImplementation(async function* (this: AgentController) {
        seenTurns.push(this.session.turns[0]?.id ?? "");
        yield* [];
      });

      const abort = new AbortController();
      setTimeout(() => abort.abort(), 50);
      await collect(controller.run(abort.signal));

      expect(seenTurns).toHaveLength(2);
      expect(seenTurns[0]).toBe(seenTurns[1]);
      expect(seenTurns[0]).toBe(session.turns[0]?.id);
    });

    it("terminates on abort signal", async () => {
      const inbox = new Inbox();
      const abort = new AbortController();
      abort.abort();
      const controller = makeController({ inbox });
      const messages = await collect(controller.run(abort.signal));
      expect(messages).toHaveLength(0);
    });

    it("triggers first-turn skill selection with the real turn id", async () => {
      const inbox = new Inbox();
      const session = makeSession();
      const skills = new SkillsModel();
      skills.register({ name: "test-skill", description: "T", content: "C" });
      inbox.push({ role: "user", text: "hello" });

      const controller = makeController({ session, inbox, skills });
      const selectSpy = vi
        .spyOn(
          controller as unknown as {
            selectSkillsForFirstTurn: () => AsyncGenerator;
          },
          "selectSkillsForFirstTurn",
        )
        .mockImplementation(async function* (this: AgentController) {
          yield {
            type: "step-finish",
            turnId: this.session.turns[0]?.id ?? "",
            finishReason: "skills: test-skill",
          };
        });
      mockStreamTurn(controller);

      const abort = new AbortController();
      setTimeout(() => abort.abort(), 50);
      const messages = await collect(controller.run(abort.signal));

      expect(selectSpy).toHaveBeenCalledTimes(1);
      expect(messages[0]).toMatchObject({
        type: "step-finish",
        finishReason: "skills: test-skill",
        turnId: session.turns[0]?.id,
      });
    });

    it("skips skill selection when no skills registered", async () => {
      const inbox = new Inbox();
      inbox.push({ role: "user", text: "hello" });
      const controller = makeController({ inbox });
      const selectSpy = vi.spyOn(
        controller as unknown as {
          selectSkillsForFirstTurn: () => AsyncGenerator;
        },
        "selectSkillsForFirstTurn",
      );
      mockStreamTurn(controller);

      const abort = new AbortController();
      setTimeout(() => abort.abort(), 50);
      await collect(controller.run(abort.signal));
      expect(selectSpy).not.toHaveBeenCalled();
    });
  });

  describe("streamTurn — finishReason classification", () => {
    async function runOnce(
      parts: Array<Record<string, unknown>>,
    ): Promise<{ session: Session; logs: LogMessage[] }> {
      const inbox = new Inbox();
      const session = makeSession();
      inbox.push({ role: "user", text: "hi" });
      mockStreamText.mockImplementation(() => ({
        fullStream: scriptStream(parts),
      }));
      const controller = makeController({ session, inbox });
      const abort = new AbortController();
      setTimeout(() => abort.abort(), 50);
      const logs = await collect(controller.run(abort.signal));
      return { session, logs };
    }

    it("classifies 'stop' with content as ok", async () => {
      const { logs, session } = await runOnce([
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", text: "hello" },
        { type: "text-end", id: "t1" },
        { type: "finish-step", finishReason: "stop" },
      ]);
      const finish = logs.find((l) => l.type === "turn-finish");
      expect(finish).toMatchObject({ kind: "ok", finishReason: "stop" });
      expect(session.turns[0]?.stopReason).toBe("stop");
    });

    it("classifies 'stop' with no content as empty", async () => {
      const { logs } = await runOnce([
        { type: "finish-step", finishReason: "stop" },
      ]);
      const finish = logs.find((l) => l.type === "turn-finish");
      expect(finish).toMatchObject({ kind: "empty", finishReason: "stop" });
    });

    it("classifies 'length' as length", async () => {
      const { logs } = await runOnce([
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", text: "partial" },
        { type: "finish-step", finishReason: "length" },
      ]);
      const finish = logs.find((l) => l.type === "turn-finish");
      expect(finish).toMatchObject({ kind: "length", finishReason: "length" });
    });

    it("classifies 'tool-calls' (SDK cut off at stopWhen) as step-limit", async () => {
      const { logs } = await runOnce([
        { type: "finish-step", finishReason: "tool-calls" },
      ]);
      const finish = logs.find((l) => l.type === "turn-finish");
      expect(finish).toMatchObject({
        kind: "step-limit",
        finishReason: "tool-calls",
      });
    });

    it("classifies 'content-filter' as filtered", async () => {
      const { logs } = await runOnce([
        { type: "finish-step", finishReason: "content-filter" },
      ]);
      const finish = logs.find((l) => l.type === "turn-finish");
      expect(finish).toMatchObject({ kind: "filtered" });
    });

    it("classifies unknown finishReason as unknown", async () => {
      const { logs } = await runOnce([
        { type: "finish-step", finishReason: "weirdness" },
      ]);
      const finish = logs.find((l) => l.type === "turn-finish");
      expect(finish).toMatchObject({
        kind: "unknown",
        finishReason: "weirdness",
      });
    });

    it("classifies stream with no finish-step as empty", async () => {
      const { logs } = await runOnce([]);
      const finish = logs.find((l) => l.type === "turn-finish");
      expect(finish).toMatchObject({ kind: "empty" });
    });
  });

  describe("streamTurn — error paths", () => {
    it("streamText throwing persists error node and yields turn-finish error", async () => {
      const inbox = new Inbox();
      const session = makeSession();
      inbox.push({ role: "user", text: "hi" });
      mockStreamText.mockImplementation(() => {
        throw new Error("network down");
      });

      const controller = makeController({ session, inbox });
      const abort = new AbortController();
      setTimeout(() => abort.abort(), 50);
      const logs = await collect(controller.run(abort.signal));

      const errorLog = logs.find((l) => l.type === "error");
      const finish = logs.find((l) => l.type === "turn-finish");
      expect(errorLog).toMatchObject({ message: "network down" });
      expect(finish).toMatchObject({ kind: "error" });

      const errorNode = session.turns[0]?.children.find(
        (c) => c.type === NodeType.error,
      );
      expect(errorNode?.content).toBe("network down");
      expect(session.turns).toHaveLength(1); // no retry spawns extra turn
    });

    it("mid-stream exception is captured once per turn", async () => {
      const inbox = new Inbox();
      const session = makeSession();
      inbox.push({ role: "user", text: "hi" });
      mockStreamText.mockImplementation(() => ({
        fullStream: (async function* () {
          yield { type: "text-start", id: "t1" };
          yield { type: "text-delta", id: "t1", text: "partial" };
          throw new Error("stream died");
        })(),
      }));

      const controller = makeController({ session, inbox });
      const abort = new AbortController();
      setTimeout(() => abort.abort(), 50);
      const logs = await collect(controller.run(abort.signal));

      expect(logs.filter((l) => l.type === "error")).toHaveLength(1);
      expect(logs.filter((l) => l.type === "turn-finish")).toHaveLength(1);
      expect(logs.find((l) => l.type === "turn-finish")).toMatchObject({
        kind: "error",
      });
    });

    it("abort mid-stream surfaces as aborted kind with no error node", async () => {
      const inbox = new Inbox();
      const session = makeSession();
      inbox.push({ role: "user", text: "hi" });
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

      const controller = makeController({ session, inbox });
      const logs = await collect(controller.run(abort.signal));

      const finish = logs.find((l) => l.type === "turn-finish");
      expect(finish).toMatchObject({ kind: "aborted" });
      expect(
        session.turns[0]?.children.some((c) => c.type === NodeType.error),
      ).toBe(false);
    });
  });

  describe("streamTurn — tool errors", () => {
    it("yields a tool-error log when the SDK emits tool-error", async () => {
      const inbox = new Inbox();
      const session = makeSession();
      inbox.push({ role: "user", text: "hi" });
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

      const controller = makeController({ session, inbox });
      const abort = new AbortController();
      setTimeout(() => abort.abort(), 50);
      const logs = await collect(controller.run(abort.signal));

      expect(logs.find((l) => l.type === "tool-error")).toMatchObject({
        toolCallId: "c1",
        toolName: "read",
        message: "permission denied",
      });
      const turn = session.turns[0] as Turn;
      expect(turn.toolCalls[0]?.isError).toBe(true);
      expect(turn.toolCalls[0]?.result).toBe("permission denied");
    });
  });

  describe("selectSkillsForFirstTurn — error persistence", () => {
    it("persists skill-selection errors on the current turn", async () => {
      const inbox = new Inbox();
      const session = makeSession();
      const skills = new SkillsModel();
      skills.register({ name: "s", description: "S", content: "C" });
      inbox.push({ role: "user", text: "hi" });

      const controller = makeController({ session, inbox, skills });

      // Make use_skills tool throw by killing the provider
      // (createUseSkillsTool uses generateText which is mocked → returns {text:""})
      // Instead, mock the internal tool directly via spy
      vi.spyOn(
        controller as unknown as {
          selectSkillsForFirstTurn: (
            m: { text: string },
            s?: AbortSignal,
          ) => AsyncGenerator;
        },
        "selectSkillsForFirstTurn",
      ).mockImplementation(async function* (this: AgentController) {
        const turn = this.session.turns[0] as Turn;
        const msg = turn.recordError(new Error("skill selection failed"));
        yield { type: "error", turnId: turn.id, message: msg };
      });
      mockStreamTurn(controller);

      const abort = new AbortController();
      setTimeout(() => abort.abort(), 50);
      await collect(controller.run(abort.signal));

      const errorNode = session.turns[0]?.children.find(
        (c) => c.type === NodeType.error,
      );
      expect(errorNode?.content).toBe("skill selection failed");
    });
  });

  describe("constructor", () => {
    it("registers builtin tools lazily when skills are available", async () => {
      const tools = new ToolRegistry();
      const skills = new SkillsModel();
      skills.register({ name: "s1", description: "S1", content: "C1" });
      const inbox = new Inbox();
      inbox.push({ role: "user", text: "hi" });
      const controller = makeController({ tools, skills, inbox });

      expect(tools.toToolSet()).not.toHaveProperty("use_skills");
      expect(tools.toToolSet()).not.toHaveProperty("list_tools");

      mockStreamTurn(controller);
      vi.spyOn(
        controller as unknown as {
          selectSkillsForFirstTurn: () => AsyncGenerator;
        },
        "selectSkillsForFirstTurn",
      ).mockImplementation(async function* () {});
      const abort = new AbortController();
      setTimeout(() => abort.abort(), 50);
      await collect(controller.run(abort.signal));

      expect(tools.toToolSet()).toHaveProperty("use_skills");
      expect(tools.toToolSet()).toHaveProperty("list_skills");
      expect(tools.toToolSet()).toHaveProperty("list_tools");
    });

    it("does not register use_skills tool when no skills", () => {
      const tools = new ToolRegistry();
      makeController({ tools });
      expect(tools.toToolSet()).not.toHaveProperty("use_skills");
    });
  });
});
