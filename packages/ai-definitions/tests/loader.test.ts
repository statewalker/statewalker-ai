// The plugin loader (statewalker/statewalker-root#82, #128): plugin sources in their own layouts in,
// the catalog in the standard layout out.
import { readText, writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { AGENT_PLUGINS_SCHEMA, loadPlugins, readPlugin } from "../src/index.js";

async function filesOf(fs: MemFilesApi, dir = "/"): Promise<string[]> {
  const out: string[] = [];
  for await (const e of fs.list(dir, { recursive: true })) if (e.kind === "file") out.push(e.path);
  return out.sort();
}

async function sources(files: Record<string, string>): Promise<MemFilesApi> {
  const fs = new MemFilesApi();
  for (const [path, text] of Object.entries(files)) await writeText(fs, path, text);
  return fs;
}

const SKILL =
  "---\nname: summarize\ndescription: Summarizes a file.\n---\nRead it, then summarize.\n";

describe("the plugin loader", () => {
  it("writes an Agent Plugins 1.0 plugin into the catalog in the standard layout", async () => {
    const src = await sources({
      "/notes/plugin.json": JSON.stringify({
        $schema: AGENT_PLUGINS_SCHEMA,
        name: "notes",
        version: "1.0.0",
        description: "Note tools",
      }),
      "/notes/skills/summarize/SKILL.md": SKILL,
      "/notes/skills/summarize/references/style.md": "Be short.",
      "/notes/mcp.json": JSON.stringify({
        mcpServers: { search: { type: "streamable-http", url: "https://mcp.example.com/" } },
      }),
      "/notes/dev.cellb.harness/agents/writer.md": "---\nname: writer\n---\nWrite notes.\n",
      "/notes/dev.cellb.harness/tools/openapi.json": "{}",
      "/notes/dev.cellb.harness/tools/word_count.ts": "export default async () => 1;",
      // Accepted and ignored: other clients' namespaces, the 1.1 draft's hooks and assets.
      "/notes/com.example.client/hooks/x.json": "{}",
      "/notes/hooks.json": "{}",
      "/notes/assets/icon.png": "png",
      "/notes/README.md": "readme",
    });
    const catalog = new MemFilesApi();
    const { plugins, problems } = await loadPlugins(src, catalog);
    expect(problems).toEqual([]);
    expect(plugins.map((p) => p.name)).toEqual(["notes"]);
    expect(plugins[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await filesOf(catalog)).toEqual([
      "/notes/dev.cellb.harness/agents/writer.md",
      "/notes/dev.cellb.harness/tools/openapi.json",
      "/notes/dev.cellb.harness/tools/word_count.ts",
      "/notes/mcp.json",
      "/notes/plugin.json",
      "/notes/skills/summarize/SKILL.md",
      "/notes/skills/summarize/references/style.md",
    ]);
    expect(JSON.parse(await readText(catalog, "/notes/plugin.json"))).toEqual({
      $schema: AGENT_PLUGINS_SCHEMA,
      name: "notes",
      version: "1.0.0",
      description: "Note tools",
    });
  });

  it("converts a Claude Code plugin into the standard layout", async () => {
    const src = await sources({
      "/review/.claude-plugin/plugin.json": JSON.stringify({
        name: "review",
        version: "0.2.0",
        description: "Code review",
        author: { name: "Ann" },
      }),
      "/review/agents/security.md":
        "---\nname: security\ndescription: Reviews for security.\nmodel: sonnet\ntools: Read, Grep, mcp__review__scan\npermissionMode: acceptEdits\n---\nLook for holes.\n",
      "/review/skills/checklist/SKILL.md": SKILL,
      "/review/.mcp.json": JSON.stringify({
        mcpServers: { scan: { type: "http", url: "https://scan.example.com/mcp" } },
      }),
      "/review/hooks/hooks.json": "{}",
    });
    const catalog = new MemFilesApi();
    const { plugins, problems } = await loadPlugins(src, catalog);
    expect(plugins.map((p) => p.name)).toEqual(["review"]);
    expect(problems).toEqual([]);
    expect(await filesOf(catalog)).toEqual([
      "/review/dev.cellb.harness/agents/security.md",
      "/review/mcp.json",
      "/review/plugin.json",
      "/review/skills/checklist/SKILL.md",
    ]);
    expect(JSON.parse(await readText(catalog, "/review/plugin.json"))).toEqual({
      $schema: AGENT_PLUGINS_SCHEMA,
      name: "review",
      version: "0.2.0",
      description: "Code review",
      author: { name: "Ann" },
    });
    expect(JSON.parse(await readText(catalog, "/review/mcp.json"))).toEqual({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { scan: { type: "streamable-http", url: "https://scan.example.com/mcp" } },
    });
    const agent = await readText(catalog, "/review/dev.cellb.harness/agents/security.md");
    expect(agent).toContain("Look for holes.");
    expect(agent).toContain("models:\n  - sonnet");
    expect(agent).not.toContain("permissionMode");
  });

  it("names a Claude Code plugin without a manifest after its folder", async () => {
    const src = await sources({ "/tiny/skills/hello/SKILL.md": SKILL });
    const catalog = new MemFilesApi();
    const { plugins } = await loadPlugins(src, catalog);
    expect(plugins.map((p) => p.name)).toEqual(["tiny"]);
    expect(await filesOf(catalog)).toEqual(["/tiny/plugin.json", "/tiny/skills/hello/SKILL.md"]);
  });

  it("rejects a plugin with a bad name or schema and reports why, loading the others", async () => {
    const src = await sources({
      "/Bad_Name/plugin.json": JSON.stringify({ $schema: AGENT_PLUGINS_SCHEMA, name: "Bad_Name" }),
      "/old/plugin.json": JSON.stringify({ $schema: "https://example.com/2.0.json", name: "old" }),
      "/good/plugin.json": JSON.stringify({ $schema: AGENT_PLUGINS_SCHEMA, name: "good", x: 1 }),
      "/good/skills/a/SKILL.md": SKILL,
    });
    const catalog = new MemFilesApi();
    const { plugins, problems } = await loadPlugins(src, catalog);
    expect(plugins.map((p) => p.name)).toEqual(["good"]);
    expect(problems).toEqual([
      expect.stringContaining("Bad_Name"),
      expect.stringContaining("good: unknown manifest field 'x'"),
      expect.stringContaining("old"),
    ]);
    expect(await filesOf(catalog)).toEqual(["/good/plugin.json", "/good/skills/a/SKILL.md"]);
  });

  it("gives the same content the same hash, and changed content a new one", async () => {
    const files = {
      "/p/plugin.json": JSON.stringify({ $schema: AGENT_PLUGINS_SCHEMA, name: "p" }),
      "/p/skills/a/SKILL.md": SKILL,
    };
    const one = await loadPlugins(await sources(files), new MemFilesApi());
    const two = await loadPlugins(await sources(files), new MemFilesApi());
    const changed = await loadPlugins(
      await sources({ ...files, "/p/skills/a/SKILL.md": `${SKILL}more\n` }),
      new MemFilesApi(),
    );
    expect(two.plugins[0]?.hash).toBe(one.plugins[0]?.hash);
    expect(changed.plugins[0]?.hash).not.toBe(one.plugins[0]?.hash);
  });

  it("ignores manifest paths that leave the plugin", async () => {
    const src = await sources({
      "/outside/skills/stolen/SKILL.md": SKILL,
      "/sneaky/.claude-plugin/plugin.json": JSON.stringify({
        name: "sneaky",
        skills: "../outside/skills",
        agents: ["../outside/agents/x.md", "./../../etc"],
        mcpServers: "../outside/.mcp.json",
      }),
    });
    const catalog = new MemFilesApi();
    const { plugins, problems } = await loadPlugins(src, catalog);
    expect(plugins.map((p) => p.name)).toEqual(["outside", "sneaky"]);
    expect(problems.filter((p) => p.startsWith("sneaky:"))).toHaveLength(4);
    expect(await filesOf(catalog, "/sneaky")).toEqual(["/sneaky/plugin.json"]);
  });

  it("never scans a plugin's parent folder: a skill at the plugin's root stays the plugin's own", async () => {
    const src = await sources({
      "/evil/.claude-plugin/plugin.json": JSON.stringify({ name: "evil", skills: ["./"] }),
      "/evil/SKILL.md": SKILL,
      "/other/SKILL.md": SKILL,
      "/other/data.txt": "sibling data",
    });
    const read = await readPlugin(src, "/evil");
    expect([...(read.plugin?.files.keys() ?? [])].sort()).toEqual([
      "plugin.json",
      "skills/evil/SKILL.md",
    ]);
  });
});
