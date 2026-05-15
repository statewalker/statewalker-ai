import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it, vi } from "vitest";
import { AgentCatalog } from "../../src/runtime/agent-catalog.js";
import type { AgentRuntime } from "../../src/runtime/agent-runtime.js";

// AgentCatalog only constructs `new Agent(def, runtime)`. The Agent ctor
// stores the runtime reference but doesn't call into it; a stub suffices.
const stubRuntime = {} as unknown as AgentRuntime;

describe("AgentCatalog — register / get / all", () => {
  it("register returns the Agent and stores it", () => {
    const cat = new AgentCatalog();
    const a = cat.register({ name: "analyst" }, stubRuntime);
    expect(a.name).toBe("analyst");
    expect(cat.get("analyst")).toBe(a);
  });

  it("register throws on duplicate name", () => {
    const cat = new AgentCatalog();
    cat.register({ name: "analyst" }, stubRuntime);
    expect(() => cat.register({ name: "analyst" }, stubRuntime)).toThrow(
      /agent already registered: analyst/,
    );
  });

  it("get returns undefined for unknown names", () => {
    const cat = new AgentCatalog();
    expect(cat.get("unknown")).toBeUndefined();
  });

  it("all returns every registered Agent", () => {
    const cat = new AgentCatalog();
    cat.register({ name: "a" }, stubRuntime);
    cat.register({ name: "b" }, stubRuntime);
    cat.register({ name: "c" }, stubRuntime);
    expect(
      cat
        .all()
        .map((x) => x.name)
        .sort(),
    ).toEqual(["a", "b", "c"]);
  });
});

describe("AgentCatalog.loadFromDisk", () => {
  it("loads .md files from disk and registers Agents", async () => {
    const files = new MemFilesApi();
    await writeText(
      files,
      "/agents/researcher.md",
      "---\nname: researcher\ndescription: Research agent\n---\nYou research.",
    );
    await writeText(
      files,
      "/agents/analyst.md",
      "---\nname: analyst\ndescription: Analysis agent\n---\nYou analyze.",
    );
    const cat = new AgentCatalog();
    const onError = vi.fn();
    await cat.loadFromDisk(files, "/agents", stubRuntime, onError);

    expect(cat.get("researcher")?.name).toBe("researcher");
    expect(cat.get("analyst")?.name).toBe("analyst");
    expect(onError).not.toHaveBeenCalled();
  });

  it("skips already-registered names", async () => {
    const files = new MemFilesApi();
    await writeText(
      files,
      "/agents/researcher.md",
      "---\nname: researcher\ndescription: From disk\n---\nDisk body.",
    );
    const cat = new AgentCatalog();
    const programmatic = cat.register({ name: "researcher" }, stubRuntime);
    await cat.loadFromDisk(files, "/agents", stubRuntime, vi.fn());
    expect(cat.get("researcher")).toBe(programmatic);
  });

  it("returns immediately when the agents folder does not exist", async () => {
    const files = new MemFilesApi();
    const cat = new AgentCatalog();
    const onError = vi.fn();
    await cat.loadFromDisk(files, "/agents", stubRuntime, onError);
    expect(cat.all()).toHaveLength(0);
    expect(onError).not.toHaveBeenCalled();
  });

  it("ignores non-.md files", async () => {
    const files = new MemFilesApi();
    await writeText(
      files,
      "/agents/researcher.md",
      "---\nname: researcher\ndescription: ok\n---\n",
    );
    await writeText(files, "/agents/readme.txt", "ignore me");
    const cat = new AgentCatalog();
    await cat.loadFromDisk(files, "/agents", stubRuntime, vi.fn());
    expect(cat.all().map((a) => a.name)).toEqual(["researcher"]);
  });
});
