import type { ProviderV3 } from "@ai-sdk/provider";
import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../../src/runtime/agent-runtime.js";

function mockProvider(): ProviderV3 {
  return { languageModel: vi.fn() } as unknown as ProviderV3;
}

async function build(files: MemFilesApi, errorHandler = vi.fn()) {
  const runtime = new AgentRuntime({ files, errorHandler });
  runtime.addModelProvider(mockProvider());
  return runtime.build();
}

// ── Agent registry (was: AgentCatalog.register / get / all) ──

describe("AgentRuntime — programmatic agent registration", () => {
  it("createAgent returns the Agent and stores it", async () => {
    const runtime = await build(new MemFilesApi());
    const a = runtime.createAgent({ name: "analyst" });
    expect(a.name).toBe("analyst");
    expect(runtime.getAgent("analyst")).toBe(a);
  });

  it("createAgent throws on duplicate name", async () => {
    const runtime = await build(new MemFilesApi());
    runtime.createAgent({ name: "analyst" });
    expect(() => runtime.createAgent({ name: "analyst" })).toThrow(
      /agent already registered: analyst/,
    );
  });

  it("getAgent returns undefined for unknown names", async () => {
    const runtime = await build(new MemFilesApi());
    expect(runtime.getAgent("unknown")).toBeUndefined();
  });

  it("agents() returns every registered Agent", async () => {
    const runtime = await build(new MemFilesApi());
    runtime.createAgent({ name: "a" });
    runtime.createAgent({ name: "b" });
    runtime.createAgent({ name: "c" });
    expect(
      runtime
        .agents()
        .map((x) => x.name)
        .sort(),
    ).toEqual(["a", "b", "c"]);
  });
});

// ── Agent loading from disk (was: AgentCatalog.loadFromDisk) ──

describe("AgentRuntime — agent disk loading via build()", () => {
  it("loads .md files from <systemPath>/agents/ and registers Agents", async () => {
    const files = new MemFilesApi();
    await writeText(
      files,
      "/.settings/agents/researcher.md",
      "---\nname: researcher\ndescription: Research agent\n---\nYou research.",
    );
    await writeText(
      files,
      "/.settings/agents/analyst.md",
      "---\nname: analyst\ndescription: Analysis agent\n---\nYou analyze.",
    );
    const onError = vi.fn();
    const runtime = await build(files, onError);

    expect(runtime.getAgent("researcher")?.name).toBe("researcher");
    expect(runtime.getAgent("analyst")?.name).toBe("analyst");
    expect(onError).not.toHaveBeenCalled();
  });

  it("disk-loaded agents do not override programmatically-registered ones", async () => {
    // Register before build so build()'s disk pass sees the existing entry.
    const files = new MemFilesApi();
    await writeText(
      files,
      "/.settings/agents/researcher.md",
      "---\nname: researcher\ndescription: From disk\n---\nDisk body.",
    );
    const runtime = new AgentRuntime({ files });
    runtime.addModelProvider(mockProvider());
    const programmatic = runtime.createAgent({ name: "researcher" });
    await runtime.build();
    expect(runtime.getAgent("researcher")).toBe(programmatic);
  });

  it("returns immediately when the agents folder does not exist", async () => {
    const files = new MemFilesApi();
    const onError = vi.fn();
    const runtime = await build(files, onError);
    expect(runtime.agents()).toHaveLength(0);
    expect(onError).not.toHaveBeenCalled();
  });

  it("ignores non-.md files", async () => {
    const files = new MemFilesApi();
    await writeText(
      files,
      "/.settings/agents/researcher.md",
      "---\nname: researcher\ndescription: ok\n---\n",
    );
    await writeText(files, "/.settings/agents/readme.txt", "ignore me");
    const runtime = await build(files);
    expect(runtime.agents().map((a) => a.name)).toEqual(["researcher"]);
  });
});

// ── Skill loading (was: SkillsLoader.load) ──

describe("AgentRuntime — skill disk loading via build()", () => {
  it("returns manual skills unchanged when the folder is missing", async () => {
    const files = new MemFilesApi();
    const runtime = new AgentRuntime({ files });
    runtime
      .addModelProvider(mockProvider())
      .addSkills({ name: "manual-1", description: "manual", content: "body" });
    await runtime.build();
    // Build an Agent that exposes all skills and inspect its resolved set.
    const agent = runtime.createAgent({ name: "a", skills: ["manual-1"] });
    const session = agent.createSession();
    expect(session.skills.available.map((s) => s.name)).toEqual(["manual-1"]);
  });

  it("appends disk skills after manual skills, preserving order", async () => {
    const files = new MemFilesApi();
    await writeText(
      files,
      "/.settings/skills/disk-1.md",
      "---\nname: disk-1\ndescription: disk skill\n---\nDisk body.",
    );
    const runtime = new AgentRuntime({ files });
    runtime
      .addModelProvider(mockProvider())
      .addSkills({ name: "manual-1", description: "manual", content: "body" });
    await runtime.build();

    const agent = runtime.createAgent({ name: "a", skills: ["manual-1", "disk-1"] });
    const session = agent.createSession();
    // available preserves registration order.
    expect(session.skills.available.map((s) => s.name)).toEqual(["manual-1", "disk-1"]);
  });

  it("ignores non-.md files", async () => {
    const files = new MemFilesApi();
    await writeText(files, "/.settings/skills/keep.md", "---\nname: keep\ndescription: ok\n---\n");
    await writeText(files, "/.settings/skills/readme.txt", "ignore");
    const runtime = await build(files);
    const agent = runtime.createAgent({ name: "a", skills: ["keep"] });
    const session = agent.createSession();
    expect(session.skills.available.map((s) => s.name)).toEqual(["keep"]);
  });

  it("routes per-file read errors through errorHandler without aborting", async () => {
    const files = new MemFilesApi();
    await writeText(
      files,
      "/.settings/skills/valid.md",
      "---\nname: valid\ndescription: ok\n---\n",
    );
    await writeText(
      files,
      "/.settings/skills/corrupt.md",
      "---\nname: corrupt\ndescription: ok\n---\n",
    );
    // Force a read error for one file by stubbing the read method on the
    // root MemFilesApi. The runtime's systemFiles is a CompositeFilesApi
    // rebased at /.settings, but read() delegates through to the root, so
    // we still stub against the original absolute path.
    const originalRead = files.read.bind(files);
    files.read = ((path: string) => {
      if (path === "/.settings/skills/corrupt.md") {
        async function* fail(): AsyncGenerator<Uint8Array> {
          yield await Promise.reject(new Error("simulated read failure"));
        }
        return fail();
      }
      return originalRead(path);
    }) as typeof files.read;

    const errorHandler = vi.fn();
    const runtime = await build(files, errorHandler);
    const agent = runtime.createAgent({ name: "a", skills: ["valid", "corrupt"] });
    const session = agent.createSession();
    expect(session.skills.available.map((s) => s.name)).toEqual(["valid"]);
    expect(errorHandler).toHaveBeenCalledTimes(1);
    // Path is reported as system-relative (the runtime's view onto systemFiles).
    expect(errorHandler.mock.calls[0]?.[1]).toEqual({ path: "/skills/corrupt.md" });
  });
});
