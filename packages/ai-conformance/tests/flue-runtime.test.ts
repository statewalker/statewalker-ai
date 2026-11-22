// Agent sessions on Flue's Cloudflare-target runtime (statewalker/statewalker-root#128): each agent
// session is a Flue session of Flue's runtime, hosted by the agent session's own Durable Object,
// on the gated file view. Flue reads the project's AGENTS.md through that view when the session's
// turn initializes; the harness keeps the turns, items and context (Flue's own compaction is off).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Deployment,
  type FakeModel,
  fakeModel,
  flueStorage,
  login,
  restClient,
  rpcClient,
  type SessionClient,
  seed,
  startDeployment,
} from "../src/index.js";

const HOST = new URL("../../ai-host-do/", import.meta.url);
const ADMIN_KEY = "conformance-admin-key";

const skill = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;

const FILES = {
  // A workspace plugin and a project plugin, both with a skill named "standup": the workspace's
  // comes first in pinned order (deployment, workspace, project), so it is the one Flue holds.
  "/.system/plugins/flteam/.claude-plugin/plugin.json": JSON.stringify({ name: "flteam" }),
  "/.system/plugins/flteam/skills/standup/SKILL.md": skill(
    "standup",
    "Team standup.",
    "STANDUP-BODY",
  ),
  "/.system/plugins/flteam/skills/standup/notes.md": "STANDUP-NOTES",
  "/.system/plugins/flteam/skills/retro/SKILL.md": skill("retro", "Team retro.", "RETRO-BODY"),
  "/fl-alpha/.system/plugins/flproj/.claude-plugin/plugin.json": JSON.stringify({ name: "flproj" }),
  "/fl-alpha/.system/plugins/flproj/skills/standup/SKILL.md": skill(
    "standup",
    "Project standup.",
    "PROJECT-STANDUP-BODY",
  ),
  "/fl-alpha/AGENTS.md": "Always answer in the house style of fl-alpha.\n",
  "/fl-alpha/readme.md": "# fl-alpha\n",
  "/fl-alpha/.system/access": JSON.stringify({ ann: "editor", bob: "reader" }),
  "/fl-beta/readme.md": "# fl-beta\n",
  // An AGENTS.md the project's ignore rules hide from agent sessions.
  "/fl-gamma/AGENTS.md": "GAMMA-HIDDEN-INSTRUCTIONS\n",
  "/fl-gamma/.system/ignore": "AGENTS.md\n",
  "/fl-gamma/.system/access": JSON.stringify({ ann: "editor" }),
  "/fl-beta/.system/access": JSON.stringify({ ann: "editor" }),
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

let model: FakeModel;
let deployment: Deployment;

beforeAll(async () => {
  model = await fakeModel();
  deployment = await startDeployment(HOST, {
    MODELS: model.deploymentModels(),
    DEV_LOGIN: "true",
    ADMIN_KEY,
  });
  await seed(deployment, ADMIN_KEY, FILES);
}, 120_000);
afterAll(async () => {
  for (const s of sockets) s.close();
  await deployment?.close();
  await model?.close();
});

describe.each(transports)("Flue's runtime over %s", (name, connect) => {
  const as = async (user: string) => connect(deployment, await login(deployment, user));

  it("reads the project's AGENTS.md through the file view into the model's system prompt", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project: "fl-alpha" });
    const text = `hello flue ${name}`;
    const turn = await ann.sendMessage(s.id, { content: text });
    expect(turn.status).toBe("completed");
    const request = model.requests.find((r) => r.lastUserText === text);
    expect(request?.system).toContain("Always answer in the house style of fl-alpha.");
    // The agent's own instructions come first; the working directory is the project's.
    expect(request?.system).toContain("working in /fl-alpha");
  });

  it("a project without AGENTS.md adds nothing of another project's", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project: "fl-beta" });
    const text = `hello beta ${name}`;
    const turn = await ann.sendMessage(s.id, { content: text });
    expect(turn.status).toBe("completed");
    const request = model.requests.find((r) => r.lastUserText === text);
    expect(request?.system).not.toContain("house style");
  });

  it("reads the workspace context only through the gated file view: an ignored AGENTS.md never reaches the model", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project: "fl-gamma" });
    const text = `hello gamma ${name}`;
    const turn = await ann.sendMessage(s.id, { content: text });
    expect(turn.status).toBe("completed");
    const request = model.requests.find((r) => r.lastUserText === text);
    expect(request?.system).toContain("working in /fl-gamma");
    expect(request?.system).not.toContain("GAMMA-HIDDEN-INSTRUCTIONS");
  });

  it("never offers Flue's own delegation: sub-agents start only through agent_start", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project: "fl-alpha" });
    const text = `tools ${name}`;
    await ann.sendMessage(s.id, { content: text });
    const request = model.requests.find((r) => r.lastUserText === text);
    expect(request?.tools).toEqual(expect.arrayContaining(["read", "write", "bash"]));
    expect(request?.tools).not.toContain("task");
  });

  it("registers the view's skills with Flue: the catalog in the prompt, activate_skill serves one", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project: "fl-alpha" });
    const text = `CALL activate_skill ${JSON.stringify({ name: "retro" })}`;
    const turn = await ann.sendMessage(s.id, { content: text });
    expect(turn.status).toBe("completed");
    const request = model.requests.find((r) => r.lastUserText === text);
    expect(request?.system).toContain("Team retro.");
    expect(request?.tools).toContain("activate_skill");
    const result = turn.items.find((i) => i.kind === "tool_result");
    expect(result).toMatchObject({ name: "activate_skill", isError: false });
    expect(result?.output).toContain("RETRO-BODY");
  });

  it("on a skill name two plugins share, Flue holds the first in pinned order; both stay in the view", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project: "fl-alpha" });
    const text = `CALL activate_skill ${JSON.stringify({ name: "standup" })}`;
    const turn = await ann.sendMessage(s.id, { content: text });
    const request = model.requests.find((r) => r.lastUserText === text);
    expect(request?.system).toContain("Team standup.");
    expect(request?.system).not.toContain("Project standup.");
    const result = turn.items.find((i) => i.kind === "tool_result");
    expect(result?.output).toContain("STANDUP-BODY");
    expect(result?.output).not.toContain("PROJECT-STANDUP-BODY");
    const read = await ann.sendMessage(s.id, {
      content: `CALL read ${JSON.stringify({ path: "/fl-alpha/.agents/skills/flproj/standup/SKILL.md" })}`,
    });
    expect(read.items.find((i) => i.kind === "tool_result")?.output).toContain(
      "PROJECT-STANDUP-BODY",
    );
  });

  it("never compacts in Flue: an answer near a large context window makes no extra model request", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project: "fl-alpha" });
    // Earlier turns Flue could fold away, were its compaction on.
    const long = "lorem ipsum dolor sit amet ".repeat(2000);
    for (const i of [1, 2, 3, 4])
      await ann.sendMessage(s.id, { content: `earlier ${i} ${name} ${long}` });
    const text = `BIG ${name}`;
    const before = model.requests.length;
    const turn = await ann.sendMessage(s.id, { content: text });
    expect(turn.status).toBe("completed");
    const made = model.requests.slice(before);
    expect(made.filter((r) => r.summary)).toEqual([]);
    expect(made.filter((r) => r.lastUserText === text)).toHaveLength(1);
    expect(turn.items.filter((i) => i.kind === "message" && i.role === "assistant")).toHaveLength(
      1,
    );
  });

  it("deletes Flue's state with the session, even from a DO that never built its Flue session", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project: "fl-alpha" });
    await ann.sendMessage(s.id, { content: `remember ${name}` });
    const rows = (tables: Record<string, number>) =>
      Object.entries(tables)
        .filter(([t]) => t !== "flue_meta")
        .reduce((n, [, c]) => n + c, 0);
    expect(rows(await flueStorage(deployment, ADMIN_KEY, s.id))).toBeGreaterThan(0);
    // A fresh DO instance holds no Flue session in memory until a turn or an alarm builds it.
    await flueStorage(deployment, ADMIN_KEY, s.id, { forget: true });
    expect(await ann.deleteSession(s.id)).toEqual({ deleted: true });
    expect(rows(await flueStorage(deployment, ADMIN_KEY, s.id))).toBe(0);
  });

  it("keeps the harness's turns: the second turn's model context is the first turn's items", async () => {
    const bob = await as("bob");
    const s = await bob.startSession({ project: "fl-alpha" });
    const first = `first ${name}`;
    const second = `second ${name}`;
    await bob.sendMessage(s.id, { content: first });
    const turn = await bob.sendMessage(s.id, { content: second });
    expect(turn.status).toBe("completed");
    const request = model.requests.find((r) => r.lastUserText === second);
    // Exactly the harness's items, in order: no Flue narration and no duplicated history.
    expect(request?.messages.filter((m) => m.role !== "system")).toEqual([
      { role: "user", text: first },
      { role: "assistant", text: "OK" },
      { role: "user", text: second },
    ]);
  });
});
