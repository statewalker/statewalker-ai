import { describe, expect, it, vi } from "vitest";
import { AgentController } from "../../src/controller/agent-controller.js";
import { Inbox } from "../../src/state/inbox.js";
import { createAgentNodeFactory, type Session } from "../../src/state/index.js";
import { SkillsModel } from "../../src/state/skills-model.js";
import { ToolRegistry } from "../../src/state/tool-registry.js";

function makeSession(): Session {
  const factory = createAgentNodeFactory();
  return factory({ type: "session" }) as Session;
}

function mockStreamTurn(controller: AgentController) {
  return vi
    .spyOn(controller as any, "streamTurn")
    .mockImplementation(async function* () {
      yield* []; // no log messages
      return "stop";
    });
}

describe("AgentController", () => {
  describe("buildSystemPrompt", () => {
    it("returns base prompt when no skills available", () => {
      const controller = new AgentController({
        session: makeSession(),
        inbox: new Inbox(),
        provider: { languageModel: vi.fn() } as any,
        model: "test",
        systemPrompt: "Base prompt",
        tools: new ToolRegistry(),
        skills: new SkillsModel(),
      });

      expect(controller.buildSystemPrompt()).toBe("Base prompt");
    });

    it("appends skills instruction when skills are available", () => {
      const skills = new SkillsModel();
      skills.register({
        name: "s1",
        description: "Skill 1",
        content: "Content 1",
      });

      const controller = new AgentController({
        session: makeSession(),
        inbox: new Inbox(),
        provider: { languageModel: vi.fn() } as any,
        model: "test",
        systemPrompt: "Base",
        tools: new ToolRegistry(),
        skills,
      });

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

      const controller = new AgentController({
        session: makeSession(),
        inbox: new Inbox(),
        provider: { languageModel: vi.fn() } as any,
        model: "test",
        systemPrompt: "Base",
        tools: new ToolRegistry(),
        skills,
      });

      const prompt = controller.buildSystemPrompt();
      expect(prompt).toContain("## Active Skills");
      expect(prompt).toContain("### file-ops");
      expect(prompt).toContain("Read and write files.");
    });
  });

  describe("run", () => {
    it("processes inbox messages sequentially", async () => {
      const inbox = new Inbox();
      const session = makeSession();

      inbox.push({ role: "user", text: "msg1" });
      inbox.push({ role: "user", text: "msg2" });

      const controller = new AgentController({
        session,
        inbox,
        provider: { languageModel: vi.fn() } as any,
        model: "test",
        systemPrompt: "Base",
        tools: new ToolRegistry(),
        skills: new SkillsModel(),
      });

      const spy = mockStreamTurn(controller);

      const abort = new AbortController();
      setTimeout(() => abort.abort(), 50);

      for await (const _msg of controller.run(abort.signal)) {
        // consume
      }

      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.calls[0]?.[0]).toBe("msg1");
      expect(spy.mock.calls[1]?.[0]).toBe("msg2");
    });

    it("terminates on abort signal", async () => {
      const inbox = new Inbox();
      const abort = new AbortController();
      abort.abort();

      const controller = new AgentController({
        session: makeSession(),
        inbox,
        provider: { languageModel: vi.fn() } as any,
        model: "test",
        systemPrompt: "Base",
        tools: new ToolRegistry(),
        skills: new SkillsModel(),
      });

      const messages: any[] = [];
      for await (const msg of controller.run(abort.signal)) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(0);
    });

    it("triggers first-turn skill selection when skills available", async () => {
      const inbox = new Inbox();
      const session = makeSession();
      const skills = new SkillsModel();
      skills.register({
        name: "test-skill",
        description: "Test",
        content: "Content",
      });

      inbox.push({ role: "user", text: "hello" });

      const controller = new AgentController({
        session,
        inbox,
        provider: { languageModel: vi.fn() } as any,
        model: "test",
        systemPrompt: "Base",
        tools: new ToolRegistry(),
        skills,
      });

      const selectSpy = vi
        .spyOn(controller as any, "selectSkillsForFirstTurn")
        .mockImplementation(async function* () {
          yield {
            type: "step-finish" as const,
            turnId: "",
            finishReason: "skills: test-skill",
          };
        });

      mockStreamTurn(controller);

      const abort = new AbortController();
      setTimeout(() => abort.abort(), 50);

      const messages: any[] = [];
      for await (const msg of controller.run(abort.signal)) {
        messages.push(msg);
      }

      expect(selectSpy).toHaveBeenCalledTimes(1);
      expect(messages[0]).toMatchObject({
        type: "step-finish",
        finishReason: "skills: test-skill",
      });
    });

    it("skips skill selection when no skills registered", async () => {
      const inbox = new Inbox();
      const session = makeSession();

      inbox.push({ role: "user", text: "hello" });

      const controller = new AgentController({
        session,
        inbox,
        provider: { languageModel: vi.fn() } as any,
        model: "test",
        systemPrompt: "Base",
        tools: new ToolRegistry(),
        skills: new SkillsModel(),
      });

      const selectSpy = vi.spyOn(controller as any, "selectSkillsForFirstTurn");
      mockStreamTurn(controller);

      const abort = new AbortController();
      setTimeout(() => abort.abort(), 50);

      for await (const _ of controller.run(abort.signal)) {
        // consume
      }

      expect(selectSpy).not.toHaveBeenCalled();
    });
  });

  describe("constructor", () => {
    it("registers builtin tools lazily when skills are available", async () => {
      const tools = new ToolRegistry();
      const skills = new SkillsModel();
      skills.register({
        name: "s1",
        description: "S1",
        content: "C1",
      });

      const inbox = new Inbox();
      inbox.push({ role: "user", text: "hi" });

      const controller = new AgentController({
        session: makeSession(),
        inbox,
        provider: { languageModel: vi.fn() } as any,
        model: "test",
        systemPrompt: "Base",
        tools,
        skills,
      });

      // Not registered yet at construction
      expect(tools.toToolSet()).not.toHaveProperty("use_skills");
      expect(tools.toToolSet()).not.toHaveProperty("list_tools");

      // Registered once run() starts
      mockStreamTurn(controller);
      const abort = new AbortController();
      setTimeout(() => abort.abort(), 50);
      for await (const _ of controller.run(abort.signal)) {
        // consume
      }

      expect(tools.toToolSet()).toHaveProperty("use_skills");
      expect(tools.toToolSet()).toHaveProperty("list_skills");
      expect(tools.toToolSet()).toHaveProperty("list_tools");
    });

    it("does not register use_skills tool when no skills", () => {
      const tools = new ToolRegistry();

      new AgentController({
        session: makeSession(),
        inbox: new Inbox(),
        provider: { languageModel: vi.fn() } as any,
        model: "test",
        systemPrompt: "Base",
        tools,
        skills: new SkillsModel(),
      });

      expect(tools.toToolSet()).not.toHaveProperty("use_skills");
    });
  });
});
