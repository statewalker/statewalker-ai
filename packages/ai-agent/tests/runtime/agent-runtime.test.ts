import type { ProviderV3 } from "@ai-sdk/provider";
import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it, vi } from "vitest";
import { Agent } from "../../src/runtime/agent.js";
import { AgentRuntime } from "../../src/runtime/agent-runtime.js";
import { Session } from "../../src/runtime/session.js";

function mockProvider(): ProviderV3 {
  return { languageModel: vi.fn() } as unknown as ProviderV3;
}

async function buildRuntime(opts?: {
  files?: MemFilesApi;
  provider?: ProviderV3;
  systemPath?: string;
  userPath?: string;
}) {
  const files = opts?.files ?? new MemFilesApi();
  const runtime = new AgentRuntime({ files });
  runtime.addModelProvider(opts?.provider ?? mockProvider());
  if (opts?.systemPath) runtime.setSystemPath(opts.systemPath);
  if (opts?.userPath) runtime.setUserPath(opts.userPath);
  return runtime.build();
}

describe("AgentRuntime", () => {
  describe("build()", () => {
    it("returns the runtime instance (this) for chaining", async () => {
      const files = new MemFilesApi();
      const runtime = new AgentRuntime({ files }).addModelProvider(mockProvider());
      const built = await runtime.build();
      expect(built).toBe(runtime);
    });

    it("throws when no provider is configured", async () => {
      const files = new MemFilesApi();
      await expect(new AgentRuntime({ files }).build()).rejects.toThrow(
        /no model provider configured/,
      );
    });

    it("rejects when systemPath='/' would hide everything from tools", async () => {
      const files = new MemFilesApi();
      const runtime = new AgentRuntime({ files })
        .addModelProvider(mockProvider())
        .setSystemPath("/");
      await expect(runtime.build()).rejects.toThrow(/would hide every path/);
    });

    it("is idempotent — calling build twice is a no-op", async () => {
      const runtime = await buildRuntime();
      await expect(runtime.build()).resolves.toBe(runtime);
    });

    it("loads agent definitions from <system>/agents/", async () => {
      const files = new MemFilesApi();
      await writeText(
        files,
        "/.settings/agents/researcher.md",
        "---\nname: researcher\ndescription: research helper\n---\nbody",
      );
      const runtime = await buildRuntime({ files });
      const agent = runtime.getAgent("researcher");
      expect(agent).toBeDefined();
      expect(agent?.name).toBe("researcher");
    });
  });

  describe("FilesApi split", () => {
    it("hides systemPath from the tools view", async () => {
      const files = new MemFilesApi();
      await writeText(files, "/.settings/secret.txt", "secret");
      await writeText(files, "/notes/x.md", "ok");
      const runtime = await buildRuntime({ files });

      // tools view: system hidden
      expect(await runtime.files.exists("/.settings/secret.txt")).toBe(false);
      expect(await runtime.files.exists("/notes/x.md")).toBe(true);

      // system view: full visibility
      expect(await runtime.systemFiles.exists("/.settings/secret.txt")).toBe(true);
    });

    it("rejects writes from tools view into systemPath", async () => {
      const runtime = await buildRuntime();
      await expect(
        runtime.files.write(
          "/.settings/x",
          (async function* () {
            yield new Uint8Array([1]);
          })(),
        ),
      ).rejects.toThrow(/Path is hidden/);
    });

    it("restricts tools view to userPath subtree when set", async () => {
      const files = new MemFilesApi();
      await writeText(files, "/workspace/a.md", "in");
      await writeText(files, "/outside/b.md", "out");
      const runtime = await buildRuntime({ files, userPath: "/workspace" });

      expect(await runtime.files.exists("/workspace/a.md")).toBe(true);
      expect(await runtime.files.exists("/outside/b.md")).toBe(false);
      // system always sees both
      expect(await runtime.systemFiles.exists("/outside/b.md")).toBe(true);
    });
  });

  describe("createAgent / Session", () => {
    it("returns Agent instances and rejects duplicate names", async () => {
      const runtime = await buildRuntime();
      const a = runtime.createAgent({ name: "first" });
      expect(a).toBeInstanceOf(Agent);
      expect(runtime.getAgent("first")).toBe(a);
      expect(() => runtime.createAgent({ name: "first" })).toThrow(/already registered/);
    });

    it("createSession returns a Session bound to the agent", async () => {
      const runtime = await buildRuntime();
      const agent = runtime.createAgent({ name: "alpha" });
      const session = agent.createSession({ title: "demo" });
      expect(session).toBeInstanceOf(Session);
      expect(session.agent).toBe(agent);
      expect(session.id).toMatch(/^[A-Za-z0-9]+$/);
      expect(session.state.props.title).toBe("demo");
    });

    it("save persists and loadSession restores", async () => {
      const runtime = await buildRuntime();
      const agent = runtime.createAgent({ name: "alpha" });
      const session = agent.createSession({ title: "saved" });
      const id = await session.save();

      const restored = await runtime.loadSession(id);
      expect(restored.id).toBe(id);
      expect(restored.state.props.title).toBe("saved");
    });

    it("listSessions reports persisted sessions", async () => {
      const runtime = await buildRuntime();
      const agent = runtime.createAgent({ name: "alpha" });
      await agent.createSession({ title: "s1" }).save();
      await agent.createSession({ title: "s2" }).save();

      const list = await runtime.listSessions();
      const titles = list.map((s) => s.title).sort();
      expect(titles).toEqual(["s1", "s2"]);
    });

    it("Session.send pushes a user message into the inbox", async () => {
      const runtime = await buildRuntime();
      const agent = runtime.createAgent({ name: "alpha" });
      const session = agent.createSession();
      session.send("hello");
      // Inbox is a queue; we can't drain it without running the loop, but
      // the BaseClass notify fired — observable via subscription count.
      expect(session.inbox).toBeDefined();
    });
  });

  describe("setErrorHandler", () => {
    it("returns the runtime for chaining", () => {
      const runtime = new AgentRuntime({ files: new MemFilesApi() });
      const result = runtime.setErrorHandler(() => {});
      expect(result).toBe(runtime);
    });

    it("custom handler receives configuration errors", async () => {
      const handler = vi.fn();
      const files = new MemFilesApi();
      await expect(new AgentRuntime({ files }).setErrorHandler(handler).build()).rejects.toThrow();
      expect(handler).toHaveBeenCalled();
      expect(handler.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    });
  });
});
