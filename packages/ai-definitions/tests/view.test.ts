// The per-role view of the catalog (statewalker/statewalker-root#82, #128): what one user may use in
// one project, as the read-only tree mounted at `<project>/.agents/`, and agents' requests narrowed
// by the same permissions.
import { readText, writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_PLUGINS_SCHEMA,
  type AgentDefinition,
  type Allow,
  definitionsView,
  findAgent,
  narrowAgent,
} from "../src/index.js";

const SKILL = (name: string) => `---\nname: ${name}\ndescription: ${name}.\n---\nDo ${name}.\n`;
const OPENAPI = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "notes", version: "1" },
  paths: {
    "/word-count": { post: { operationId: "word_count", summary: "Counts words" } },
    "/delete-all": { post: { operationId: "delete_all", summary: "Deletes every note" } },
  },
});

let catalog: MemFilesApi;
beforeEach(async () => {
  catalog = new MemFilesApi();
  const files: Record<string, string> = {
    "/notes/plugin.json": JSON.stringify({ $schema: AGENT_PLUGINS_SCHEMA, name: "notes" }),
    "/notes/skills/summarize/SKILL.md": SKILL("summarize"),
    "/notes/skills/summarize/references/style.md": "Be short.",
    "/notes/skills/draft/SKILL.md": SKILL("draft"),
    "/notes/dev.cellb.harness/agents/writer.md": [
      "---",
      "name: writer",
      "description: Writes notes.",
      "models: [big, small]",
      "skills: [notes/summarize, review/checklist]",
      "tools: ['*']",
      "agents: [review/*, notes/*]",
      "mode: plan",
      "requires: [shell]",
      "---",
      "You write notes.",
      "",
    ].join("\n"),
    "/notes/dev.cellb.harness/agents/lister.md": "---\nname: lister\n---\nYou list.\n",
    "/notes/dev.cellb.harness/tools/openapi.json": OPENAPI,
    "/review/plugin.json": JSON.stringify({ $schema: AGENT_PLUGINS_SCHEMA, name: "review" }),
    "/review/skills/checklist/SKILL.md": SKILL("checklist"),
    "/review/dev.cellb.harness/agents/security.md": "---\nname: security\n---\nLook.\n",
  };
  for (const [path, text] of Object.entries(files)) await writeText(catalog, path, text);
});

/** An allow function from `area:<plugin>/<name>` patterns, `*` matching anything. */
const allowing =
  (...patterns: string[]): Allow =>
  (area, target) =>
    patterns.some((p) => {
      const [a, t] = p.split(":") as [string, string];
      return (
        a === area && new RegExp(`^${t.replace(/[.]/g, "\\.").replace(/\*/g, ".*")}$`).test(target)
      );
    });

async function agentOf(id: string): Promise<AgentDefinition> {
  const agent = await findAgent(catalog, id);
  if (!agent) throw new Error(`no agent ${id}`);
  return agent;
}

async function tree(fs: { list: MemFilesApi["list"] }): Promise<string[]> {
  const out: string[] = [];
  for await (const e of fs.list("/", { recursive: true })) if (e.kind === "file") out.push(e.path);
  return out.sort();
}

describe("the definitions view", () => {
  it("shows the skills, agents and tools the permissions allow, skills nested by plugin", async () => {
    const view = await definitionsView(catalog, {
      allow: allowing("skills:notes/*", "agents:notes/writer", "tools:notes/word_count"),
    });
    expect(await tree(view)).toEqual([
      "/agents/notes__writer.md",
      "/skills/notes/draft/SKILL.md",
      "/skills/notes/summarize/SKILL.md",
      "/skills/notes/summarize/references/style.md",
      "/tools/notes__word_count.openapi.json",
    ]);
    expect(await readText(view, "/skills/notes/summarize/SKILL.md")).toBe(SKILL("summarize"));
    const tool = JSON.parse(await readText(view, "/tools/notes__word_count.openapi.json"));
    expect(tool.paths["/tools/notes/word_count"].post.operationId).toBe("word_count");
    // Hidden ones are absent, under any path.
    expect(await view.exists("/skills/review/checklist/SKILL.md")).toBe(false);
    expect(await view.exists("/tools/notes__delete_all.openapi.json")).toBe(false);
    // A plugin's skills folder shows only while one of its skills does.
    const top: string[] = [];
    for await (const e of view.list("/skills")) top.push(e.name);
    expect(top).toEqual(["notes"]);
    expect(await view.exists("/skills/review")).toBe(false);
  });

  it("decides each read by the permissions now, so a demotion reaches an open view", async () => {
    let skills = true;
    const view = await definitionsView(catalog, {
      allow: (area, target) => area === "skills" && skills && target.startsWith("notes/"),
    });
    expect(await view.exists("/skills/notes/draft/SKILL.md")).toBe(true);
    skills = false;
    expect(await view.exists("/skills/notes/draft/SKILL.md")).toBe(false);
    expect(await tree(view)).toEqual([]);
  });

  it("is read-only", async () => {
    const view = await definitionsView(catalog, { allow: allowing("skills:*") });
    await expect(writeText(view, "/skills/notes/draft/SKILL.md", "x")).rejects.toThrow(/EACCES/);
    await expect(view.remove("/skills/notes/draft")).rejects.toThrow(/EACCES/);
    await expect(view.mkdir("/skills/new")).rejects.toThrow(/EACCES/);
    expect(await readText(view, "/skills/notes/draft/SKILL.md")).toBe(SKILL("draft"));
  });

  it("shows an agent's session only the skills the agent asks for, of those allowed", async () => {
    const allow = allowing("skills:*", "agents:*", "tools:*", "models:*");
    const writer = await narrowAgent(catalog, await agentOf("notes/writer"), allow);
    const view = await definitionsView(catalog, { allow, agent: writer });
    expect((await tree(view)).filter((p) => p.startsWith("/skills/"))).toEqual([
      "/skills/notes/summarize/SKILL.md",
      "/skills/notes/summarize/references/style.md",
      "/skills/review/checklist/SKILL.md",
    ]);
    // An agent without a skills list gets every visible skill.
    const lister = await narrowAgent(catalog, await agentOf("notes/lister"), allow);
    expect(lister.skills).toEqual(["notes/draft", "notes/summarize", "review/checklist"]);
  });
});

describe("agent definitions", () => {
  it("parses the front matter and narrows every list by the permissions", async () => {
    const writer = await findAgent(catalog, "notes/writer");
    expect(writer).toMatchObject({
      id: "notes/writer",
      plugin: "notes",
      name: "writer",
      description: "Writes notes.",
      models: ["big", "small"],
      mode: "plan",
      requires: ["shell"],
      instructions: "You write notes.\n",
    });
    const narrowed = await narrowAgent(
      catalog,
      writer as AgentDefinition,
      allowing(
        "skills:notes/*",
        "tools:notes/word_count",
        "agents:review/security",
        "models:small",
      ),
    );
    expect(narrowed).toMatchObject({
      models: ["small"],
      skills: ["notes/summarize"],
      tools: ["notes/word_count"],
      agents: ["review/security"],
    });
  });

  it("gives an agent without tool or agent lists none of either", async () => {
    const lister = await narrowAgent(
      catalog,
      await agentOf("notes/lister"),
      allowing("skills:*", "agents:*", "tools:*", "models:*"),
    );
    expect(lister).toMatchObject({ tools: [], agents: [], models: [] });
  });

  it("finds no agent that isn't in the catalog", async () => {
    expect(await findAgent(catalog, "notes/nobody")).toBeUndefined();
    expect(await findAgent(catalog, "../notes/writer")).toBeUndefined();
  });
});
