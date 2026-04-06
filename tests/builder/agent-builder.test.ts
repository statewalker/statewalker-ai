import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { tool } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Agent } from "../../src/builder/agent.js";
import {
  AgentBuilder,
  type ToolFactory,
} from "../../src/builder/agent-builder.js";
import { AgentManager } from "../../src/builder/agent-manager.js";

function mockProvider() {
  return { languageModel: vi.fn() } as any;
}

describe("AgentBuilder", () => {
  let files: MemFilesApi;

  beforeEach(() => {
    files = new MemFilesApi();
  });

  describe("build()", () => {
    it("creates an Agent with all components wired", async () => {
      const agent = await new AgentBuilder()
        .withProvider(mockProvider())
        .withModel("test-model")
        .withFilesApi(files)
        .withSystemFolder("/.settings")
        .build();

      expect(agent).toBeInstanceOf(Agent);
      expect(agent.controller).toBeDefined();
      expect(agent.context).toBeDefined();
      expect(agent.inbox).toBeDefined();
      expect(agent.session).toBeDefined();
    });

    it("throws without provider", async () => {
      await expect(
        new AgentBuilder().withModel("test").withFilesApi(files).build(),
      ).rejects.toThrow("Provider not configured");
    });

    it("throws without filesApi", async () => {
      await expect(
        new AgentBuilder()
          .withProvider(mockProvider())
          .withModel("test")
          .build(),
      ).rejects.toThrow("FilesApi not configured");
    });
  });

  describe("dual FilesApi split", () => {
    it("systemFiles can read the system folder", async () => {
      // Pre-populate the FS
      await writeText(files, "/.settings/key.json", '{"apiKey":"test"}');
      await writeText(files, "/project/readme.md", "# Hello");

      const agent = await new AgentBuilder()
        .withProvider(mockProvider())
        .withModel("test")
        .withFilesApi(files)
        .withSystemFolder("/.settings")
        .build();

      // systemFiles is the full FS
      expect(
        await agent.context.systemFiles.exists("/.settings/key.json"),
      ).toBe(true);
    });

    it("workingFiles guards block writes to system folder", async () => {
      const agent = await new AgentBuilder()
        .withProvider(mockProvider())
        .withModel("test")
        .withFilesApi(files)
        .withSystemFolder("/.settings")
        .build();

      // Writing to system folder should throw
      const enc = new TextEncoder();
      await expect(
        agent.context.files.write("/.settings/hack.json", [enc.encode("bad")]),
      ).rejects.toThrow("Access denied");
    });

    it("workingFiles allows writes outside system folder", async () => {
      const agent = await new AgentBuilder()
        .withProvider(mockProvider())
        .withModel("test")
        .withFilesApi(files)
        .withSystemFolder("/.settings")
        .build();

      const enc = new TextEncoder();
      await agent.context.files.write("/project/file.txt", [enc.encode("ok")]);
      expect(await files.exists("/project/file.txt")).toBe(true);
    });

    it("respects custom excluded paths", async () => {
      const agent = await new AgentBuilder()
        .withProvider(mockProvider())
        .withModel("test")
        .withFilesApi(files)
        .withSystemFolder("/.settings")
        .withExcludedPaths(".git", "node_modules")
        .build();

      const enc = new TextEncoder();
      await expect(
        agent.context.files.write("/.git/config", [enc.encode("x")]),
      ).rejects.toThrow("Access denied");
      await expect(
        agent.context.files.write("/node_modules/pkg/x", [enc.encode("x")]),
      ).rejects.toThrow("Access denied");
    });
  });

  describe("tool registration", () => {
    it("registers static tools", async () => {
      const testTool = tool({
        description: "Test tool",
        inputSchema: z.object({}),
        execute: async () => "ok",
      });

      const agent = await new AgentBuilder()
        .withProvider(mockProvider())
        .withModel("test")
        .withFilesApi(files)
        .withTools({ test_tool: testTool })
        .build();

      const toolSet = agent.controller.tools.toToolSet();
      expect(toolSet).toHaveProperty("test_tool");
    });

    it("resolves tool factories with AgentContext", async () => {
      let receivedCtx: any = null;

      const factory: ToolFactory = (ctx) => {
        receivedCtx = ctx;
        const myTool = tool({
          description: "Factory tool",
          inputSchema: z.object({}),
          execute: async () => "from-factory",
        });
        return { factory_tool: myTool };
      };

      const agent = await new AgentBuilder()
        .withProvider(mockProvider())
        .withModel("test")
        .withFilesApi(files)
        .withTools(factory)
        .build();

      // Factory was called with AgentContext
      expect(receivedCtx).not.toBeNull();
      expect(receivedCtx.files).toBeDefined();
      expect(receivedCtx.systemFiles).toBeDefined();
      expect(receivedCtx.config).toBeDefined();
      expect(receivedCtx.secrets).toBeDefined();
      expect(receivedCtx.sessions).toBeDefined();

      const toolSet = agent.controller.tools.toToolSet();
      expect(toolSet).toHaveProperty("factory_tool");
    });
  });

  describe("skills folder", () => {
    it("loads .md skills from skills folder", async () => {
      await writeText(
        files,
        "/.settings/skills/code-review.md",
        "---\nname: code-review\ndescription: Reviews code\n---\nReview the code carefully.",
      );
      await writeText(
        files,
        "/.settings/skills/testing.md",
        "---\nname: testing\ndescription: Writes tests\n---\nWrite comprehensive tests.",
      );

      const agent = await new AgentBuilder()
        .withProvider(mockProvider())
        .withModel("test")
        .withFilesApi(files)
        .withSkillsFolder("/.settings/skills/")
        .build();

      expect(agent.controller.skills.size).toBe(2);
      const available = agent.controller.skills.available;
      const names = available.map((s) => s.name);
      expect(names).toContain("code-review");
      expect(names).toContain("testing");
    });

    it("skips non-.md files in skills folder", async () => {
      await writeText(files, "/.settings/skills/readme.txt", "Not a skill");
      await writeText(
        files,
        "/.settings/skills/valid.md",
        "---\nname: valid\ndescription: A skill\n---\nContent",
      );

      const agent = await new AgentBuilder()
        .withProvider(mockProvider())
        .withModel("test")
        .withFilesApi(files)
        .withSkillsFolder("/.settings/skills/")
        .build();

      expect(agent.controller.skills.size).toBe(1);
    });

    it("handles missing skills folder gracefully", async () => {
      const agent = await new AgentBuilder()
        .withProvider(mockProvider())
        .withModel("test")
        .withFilesApi(files)
        .withSkillsFolder("/.settings/skills/")
        .build();

      expect(agent.controller.skills.size).toBe(0);
    });
  });

  describe("system prompt and config", () => {
    it("passes system prompt to controller", async () => {
      const agent = await new AgentBuilder()
        .withProvider(mockProvider())
        .withModel("test")
        .withFilesApi(files)
        .withSystemPrompt("Custom prompt")
        .build();

      expect(agent.controller.systemPrompt).toBe("Custom prompt");
    });

    it("passes maxSteps to controller", async () => {
      const agent = await new AgentBuilder()
        .withProvider(mockProvider())
        .withModel("test")
        .withFilesApi(files)
        .withMaxSteps(25)
        .build();

      expect(agent.controller.maxSteps).toBe(25);
    });
  });

  describe("ConfigManager and SecretsManager", () => {
    it("creates config and secrets managers from systemFiles", async () => {
      await writeText(
        files,
        "/.settings/key.json",
        JSON.stringify({
          apiKey: "sk-123",
          provider: "anthropic",
          models: [],
        }),
      );

      const agent = await new AgentBuilder()
        .withProvider(mockProvider())
        .withModel("test")
        .withFilesApi(files)
        .withSystemFolder("/.settings")
        .build();

      // Config can read from the system FS
      const keyData = await agent.context.secrets.getApiKey();
      expect(keyData).toBeDefined();
      expect(keyData?.apiKey).toBe("sk-123");
    });
  });
});

describe("AgentManager", () => {
  let files: MemFilesApi;
  let builder: AgentBuilder;

  beforeEach(() => {
    files = new MemFilesApi();
    builder = new AgentBuilder()
      .withProvider(mockProvider())
      .withModel("test")
      .withFilesApi(files)
      .withSystemFolder("/.settings");
  });

  it("create() produces a new agent", async () => {
    const manager = new AgentManager(builder);
    const agent = await manager.create("My chat");
    expect(agent).toBeInstanceOf(Agent);
    expect(manager.active).toBe(agent);
  });

  it("list() returns created sessions", async () => {
    const manager = new AgentManager(builder);
    await manager.create("Chat 1");
    await manager.create("Chat 2");

    const list = await manager.list();
    expect(list.length).toBeGreaterThanOrEqual(2);
  });

  it("delete() removes a non-active session", async () => {
    // Create an agent and manually create a second session via SessionManager
    const manager = new AgentManager(builder);
    const agent = await manager.create("Active");
    const extraId = await agent.context.sessions.create("Extra");

    const listBefore = await manager.list();
    expect(listBefore.length).toBeGreaterThanOrEqual(2);

    const result = await manager.delete(extraId);
    expect(result).toBe(true);

    const listAfter = await manager.list();
    expect(listAfter.find((s) => s.id === extraId)).toBeUndefined();
  });

  it("delete() throws for active session", async () => {
    const manager = new AgentManager(builder);
    await manager.create("Active");

    const list = await manager.list();
    const activeId = list[0]?.id ?? "";

    await expect(manager.delete(activeId)).rejects.toThrow("active session");
  });
});
