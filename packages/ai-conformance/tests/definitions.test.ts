// Definitions (statewalker/statewalker-root#128): plugins from the deployment's catalog, the
// workspace's system folder and each project's `.system/plugins/`, in the Agent Plugins 1.0 and
// Claude Code layouts, shown to each agent session as the read-only `<project>/.agents/` tree its
// user's role allows; agents picked at session start (or the project's, then the deployment's,
// default), their requests narrowed by the same permissions, and pinned for the session's life.
// Against the harness's own deployment on CellB Node in-process, with the scripted model.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Deployment,
  type FakeModel,
  fakeModel,
  login,
  restClient,
  rpcClient,
  type SessionClient,
  seed,
  startDeployment,
  type Turn,
} from "../src/index.js";

const HOST = new URL("../../ai-host-do/", import.meta.url);
const ADMIN_KEY = "conformance-admin-key";
const AP = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

const skill = (name: string, text = `Do ${name}.`) =>
  `---\nname: ${name}\ndescription: ${name}.\n---\n${text}\n`;

/** The deployment's catalog: plugin sources, one folder each. */
const CATALOG = {
  "/core/plugin.json": JSON.stringify({ $schema: AP, name: "core", version: "1.0.0" }),
  "/core/skills/summarize/SKILL.md": skill("summarize"),
  "/core/skills/audit/SKILL.md": skill("audit"),
  "/core/dev.cellb.harness/agents/writer.md": [
    "---",
    "name: writer",
    "description: Writes.",
    "models: [big, small]",
    "skills: [core/summarize, team/*]",
    "---",
    "WRITER-INSTRUCTIONS: you write.",
    "",
  ].join("\n"),
  "/core/dev.cellb.harness/agents/default.md":
    "---\nname: default\n---\nDEPLOYMENT-DEFAULT-INSTRUCTIONS\n",
};

type Connect = (deployment: Deployment, token: string) => Promise<SessionClient>;
const sockets: { close(): void }[] = [];
const transports: [string, Connect][] = [
  ["REST", async (d, token) => restClient(d, token)],
  [
    "RPC",
    async (d, token) => {
      const client = await rpcClient(d, token);
      sockets.push(client);
      return client;
    },
  ],
];

/** Each transport's own projects, so the scenarios don't share files. */
function projectFiles(t: string): Record<string, string> {
  const alpha = `alpha-${t}`;
  const beta = `beta-${t}`;
  return {
    [`/${alpha}/readme.md`]: "# alpha\n",
    [`/${alpha}/.system/access`]: JSON.stringify({
      [`ann-${t}`]: "reader",
      [`cus-${t}`]: "limited",
      [`eve-${t}`]: "editor",
    }),
    [`/${alpha}/.system/roles`]: JSON.stringify({
      limited:
        "files.read, files.list, skills.use:core/summarize, agents.use:core/*, models.use:small",
    }),
    [`/${alpha}/.system/settings`]: JSON.stringify({ agent: "proj/helper" }),
    // The project's own plugin, in the Agent Plugins layout.
    [`/${alpha}/.system/plugins/proj/plugin.json`]: JSON.stringify({ $schema: AP, name: "proj" }),
    [`/${alpha}/.system/plugins/proj/skills/house-style/SKILL.md`]: skill("house-style", "V1"),
    [`/${alpha}/.system/plugins/proj/dev.cellb.harness/agents/helper.md`]:
      "---\nname: helper\n---\nPROJECT-DEFAULT-INSTRUCTIONS\n",
    // A project plugin taking a deployment plugin's name: the deployment's stays.
    [`/${alpha}/.system/plugins/fake-core/plugin.json`]: JSON.stringify({
      $schema: AP,
      name: "core",
    }),
    [`/${alpha}/.system/plugins/fake-core/skills/evil/SKILL.md`]: skill("evil"),
    // A project whose name has capitals.
    [`/Gamma-${t}/.system/access`]: JSON.stringify({ [`eve-${t}`]: "editor" }),
    [`/${beta}/.system/access`]: JSON.stringify({ [`ann-${t}`]: "reader" }),
  };
}

const FILES: Record<string, string> = {
  // The workspace's plugin, in the Claude Code layout.
  "/.system/plugins/team/.claude-plugin/plugin.json": JSON.stringify({ name: "team" }),
  "/.system/plugins/team/skills/standup/SKILL.md": skill("standup"),
  "/.system/plugins/team/agents/scrum.md":
    "---\nname: scrum\ndescription: Runs standups.\n---\nSCRUM\n",
  ...projectFiles("rest"),
  ...projectFiles("rpc"),
};

let model: FakeModel;
let deployment: Deployment;

beforeAll(async () => {
  model = await fakeModel();
  deployment = await startDeployment(HOST, {
    LLM_BASE_URL: model.url,
    DEV_LOGIN: "true",
    ADMIN_KEY,
    CATALOG: JSON.stringify(CATALOG),
    DEFAULT_AGENT: "core/default",
  });
  await seed(deployment, ADMIN_KEY, FILES);
}, 120_000);
afterAll(async () => {
  for (const s of sockets) s.close();
  await deployment?.close();
  await model?.close();
});

const call = (tool: string, args: unknown) => `CALL ${tool} ${JSON.stringify(args)}`;
const toolResult = (turn: Turn) => turn.items.find((i) => i.kind === "tool_result");

describe.each(transports)("definitions over %s", (name, connect) => {
  const t = name.toLowerCase();
  const alpha = `alpha-${t}`;
  const beta = `beta-${t}`;
  const as = async (user: string) => connect(deployment, await login(deployment, `${user}-${t}`));
  const run = async (client: SessionClient, session: string, tool: string, args: unknown) =>
    toolResult(await client.sendMessage(session, { content: call(tool, args) }));
  const ls = async (client: SessionClient, session: string, path: string) =>
    String((await run(client, session, "bash", { command: `ls ${path}` }))?.output ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .sort();

  it("mounts at <project>/.agents/ the skills and agents of all three levels, as <plugin>__<name>", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project: alpha, agent: "core/writer" });
    // The writer asks for core/summarize and team/*: only those skills show in its session.
    expect(await ls(ann, s.id, `/${alpha}/.agents/skills`)).toEqual([
      "core__summarize",
      "team__standup",
    ]);
    expect(await ls(ann, s.id, `/${alpha}/.agents/agents`)).toEqual([
      "core__default.md",
      "core__writer.md",
      "proj__helper.md",
      "team__scrum.md",
    ]);
    const read = await run(ann, s.id, "read", {
      path: `/${alpha}/.agents/skills/team__standup/SKILL.md`,
    });
    expect(read).toMatchObject({ isError: false, output: skill("standup") });
  });

  it("shows only what the role's skills.use and agents.use permissions allow", async () => {
    const cus = await as("cus");
    const s = await cus.startSession({ project: alpha, agent: "core/default" });
    expect(await ls(cus, s.id, `/${alpha}/.agents/skills`)).toEqual(["core__summarize"]);
    expect(await ls(cus, s.id, `/${alpha}/.agents/agents`)).toEqual([
      "core__default.md",
      "core__writer.md",
    ]);
    const hidden = await run(cus, s.id, "read", {
      path: `/${alpha}/.agents/skills/core__audit/SKILL.md`,
    });
    expect(hidden).toMatchObject({ isError: true });
    expect(hidden?.output).toMatch(/ENOENT/);
  });

  it("keeps the mount read-only, whatever the role", async () => {
    const eve = await as("eve");
    const s = await eve.startSession({ project: alpha });
    const write = await run(eve, s.id, "write", {
      path: `/${alpha}/.agents/skills/core__summarize/SKILL.md`,
      content: "changed",
    });
    expect(write).toMatchObject({ isError: true });
    const rm = await run(eve, s.id, "bash", { command: `rm -r /${alpha}/.agents/skills` });
    expect(rm?.output).toMatch(/EACCES|read-only|ermission/);
    const after = await run(eve, s.id, "read", {
      path: `/${alpha}/.agents/skills/core__summarize/SKILL.md`,
    });
    expect(after).toMatchObject({ isError: false, output: skill("summarize") });
  });

  it("starts the agent the user picks, with its instructions and its narrowed models", async () => {
    const cus = await as("cus");
    const s = await cus.startSession({ project: alpha, agent: "core/writer" });
    expect(s).toMatchObject({ agent: "core/writer" });
    await cus.sendMessage(s.id, { content: "hello" });
    const request = model.requests.at(-1);
    expect(request?.system).toContain("WRITER-INSTRUCTIONS");
    // big is not the role's (models.use:small), so the writer runs on small.
    expect(request?.model).toBe("small");
  });

  it("refuses an agent the user may not use or that no plugin has", async () => {
    const cus = await as("cus");
    for (const agent of ["proj/helper", "team/scrum", "core/nobody", "nobody/x"])
      await expect(cus.startSession({ project: alpha, agent })).rejects.toMatchObject({
        status: 404,
      });
    await expect(cus.startSession({ project: alpha, agent: "a/b/c" })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("starts the project's default agent, or else the deployment's, when none is picked", async () => {
    const ann = await as("ann");
    const inAlpha = await ann.startSession({ project: alpha });
    expect(inAlpha).toMatchObject({ agent: "proj/helper" });
    await ann.sendMessage(inAlpha.id, { content: "hello" });
    expect(model.requests.at(-1)?.system).toContain("PROJECT-DEFAULT-INSTRUCTIONS");
    const inBeta = await ann.startSession({ project: beta });
    expect(inBeta).toMatchObject({ agent: "core/default" });
    await ann.sendMessage(inBeta.id, { content: "hello" });
    expect(model.requests.at(-1)?.system).toContain("DEPLOYMENT-DEFAULT-INSTRUCTIONS");
  });

  it("pins a session's definitions at start: a plugin update reaches only new sessions", async () => {
    const ann = await as("ann");
    const path = `/${alpha}/.agents/skills/proj__house-style/SKILL.md`;
    const before = await ann.startSession({ project: alpha, agent: "proj/helper" });
    expect((await run(ann, before.id, "read", { path }))?.output).toBe(skill("house-style", "V1"));
    await seed(deployment, ADMIN_KEY, {
      [`/${alpha}/.system/plugins/proj/skills/house-style/SKILL.md`]: skill("house-style", "V2"),
    });
    expect((await run(ann, before.id, "read", { path }))?.output).toBe(skill("house-style", "V1"));
    const after = await ann.startSession({ project: alpha, agent: "proj/helper" });
    expect((await run(ann, after.id, "read", { path }))?.output).toBe(skill("house-style", "V2"));
    await seed(deployment, ADMIN_KEY, {
      [`/${alpha}/.system/plugins/proj/skills/house-style/SKILL.md`]: skill("house-style", "V1"),
    });
  });

  it("keeps a broader level's plugin when a project's plugin takes its name", async () => {
    const ann = await as("ann");
    // The project's default agent asks for no skills list: every visible skill shows.
    const s = await ann.startSession({ project: alpha });
    expect(await ls(ann, s.id, `/${alpha}/.agents/skills`)).toEqual([
      "core__audit",
      "core__summarize",
      "proj__house-style",
      "team__standup",
    ]);
  });

  it("refuses changes to the mount without asking, in a project whose name has capitals", async () => {
    const eve = await as("eve");
    const project = `Gamma-${t}`;
    const s = await eve.startSession({ project });
    const turn = await eve.sendMessage(s.id, {
      content: call("write", { path: `/${project}/.agents/skills/x/SKILL.md`, content: "x" }),
    });
    expect(turn.status).toBe("completed");
    expect(toolResult(turn)).toMatchObject({ isError: true });
    expect(toolResult(turn)?.output).toMatch(/read-only/);
  });
});
