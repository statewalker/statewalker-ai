// Sub-agents and subtree revocation (statewalker/statewalker-root#126, decided in #89, #79 and
// #87): an agent session starts a child session with the harness tool `agent.start` (the model
// calls it `agent_start`), limited to what the parent may do: its tools never exceed the parent's
// and its mode is the same or stricter. The user controls the whole tree: a child's approvals
// reach the root session's events stream and `/v1/me`, archiving a session revokes its subtree
// (siblings keep running), revoking the user session stops every agent session, and agents
// outlive the user's access token. Run against the harness's own deployment (ai-host-do) on CellB
// Node in-process, with the scripted model, over REST and RPC.
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
  sendPastUser,
  startDeployment,
  type Turn,
} from "../src/index.js";

const HOST = new URL("../../ai-host-do/", import.meta.url);
const ADMIN_KEY = "conformance-admin-key";

const USERS = ["ann", "bob", "cy", "dee", "eli", "fay", "gus", "hal", "ivy", "jo"];
const TRANSPORTS = ["rest", "rpc"];

const AP = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const agentFile = (name: string, agents?: string[]) =>
  `---\nname: ${name}\n${agents ? `agents: [${agents.join(", ")}]\n` : ""}---\nYou are ${name}.\n`;
const TEAM = [
  ...["lead", "helper", "leaf", "careful", "loose", "odd", "writer", "doomed", "doomed-child"],
  ...["sibling", "cut", "cut-child", "kept", "late"],
];
/** The deployment's catalog: every `team` agent may start any `team` agent; `solo` lists none. */
const CATALOG: Record<string, string> = {
  "/team/plugin.json": JSON.stringify({ $schema: AP, name: "team" }),
  "/team/dev.cellb.harness/agents/solo.md": agentFile("solo"),
  "/other/plugin.json": JSON.stringify({ $schema: AP, name: "other" }),
  "/other/dev.cellb.harness/agents/outsider.md": agentFile("outsider", ["team/*"]),
};
for (const name of TEAM)
  CATALOG[`/team/dev.cellb.harness/agents/${name}.md`] = agentFile(name, ["team/*", "other/*"]);

function fixtures(): Record<string, string> {
  const access: Record<string, string> = {};
  for (const t of TRANSPORTS) for (const u of USERS) access[`${u}-${t}`] = "editor";
  // Ivy may use two agents only.
  for (const t of TRANSPORTS) access[`ivy-${t}`] = "limited";
  return {
    "/alpha/readme.md": "# alpha\n",
    "/alpha/.system/access": JSON.stringify(access),
    "/alpha/.system/roles": JSON.stringify({
      limited:
        "files.read, files.list, agents.use:team/lead, agents.use:team/helper, models.use:default",
    }),
  };
}

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
    CATALOG: JSON.stringify(CATALOG),
  });
  await seed(deployment, ADMIN_KEY, fixtures());
}, 120_000);
afterAll(async () => {
  for (const s of sockets) s.close();
  await deployment?.close();
  await model?.close();
});

const call = (tool: string, args: unknown) => `CALL ${tool} ${JSON.stringify(args)}`;
const read = (path: string) => call("read", { path });
const write = (path: string, content = "x\n") => call("write", { path, content });
const start = (args: { agent: string; message: string; mode?: string; tools?: string[] }) =>
  call("agent_start", args);
const results = (turn: Turn) => turn.items.filter((i) => i.kind === "tool_result");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.each(transports)("sub-agents over %s", (name, connect) => {
  const t = name.toLowerCase();
  const u = (user: string) => `${user}-${t}`;
  const as = async (user: string) => connect(deployment, await login(deployment, u(user)));

  it("agent.start runs a child session and hands its answer back to the parent", async () => {
    const ann = await as("ann");
    const parent = await ann.startSession({ project: "alpha", agent: "team/lead" });
    const turn = await ann.sendMessage(parent.id, {
      content: start({ agent: "team/helper", message: read("/alpha/readme.md") }),
    });
    expect(turn.status).toBe("completed");
    const [result] = results(turn);
    expect(result).toMatchObject({ isError: false, name: "agent_start" });
    // The child's answer: its own model's reply to the file it read.
    expect(result?.output).toContain("RESULT: # alpha");
    // The child is one of the user's agent sessions, under its parent.
    const { sessions } = await ann.listSessions();
    const child = sessions.find((s) => s.parent === parent.id);
    expect(child).toMatchObject({ agent: "team/helper", project: "alpha", root: parent.id });
    expect(result?.output).toContain(String(child?.id));
    const items = await ann.listItems(String(child?.id));
    expect(items.items.filter((i) => i.kind === "tool_result")).toEqual([
      expect.objectContaining({ isError: false, output: "# alpha\n" }),
    ]);
  });

  it("a child's tools never exceed its parent's", async () => {
    const bob = await as("bob");
    const parent = await bob.startSession({ project: "alpha", agent: "team/lead" });
    const leaf = `leaf task ${t}`;
    const middle = start({ agent: "team/leaf", tools: ["read", "write", "bash"], message: leaf });
    const turn = await bob.sendMessage(parent.id, {
      content: start({ agent: "team/helper", tools: ["read", "agent_start"], message: middle }),
    });
    expect(turn.status).toBe("completed");
    const offered = (text: string) =>
      [...(model.requests.find((r) => r.lastUserText === text)?.tools ?? [])].sort();
    // The parent is offered every tool; the child only what it was given; the grandchild only
    // what it asked for that the child holds.
    expect(
      offered(start({ agent: "team/helper", tools: ["read", "agent_start"], message: middle })),
    ).toEqual(expect.arrayContaining(["agent_start", "bash", "read", "write"]));
    expect(offered(middle)).toEqual(["agent_start", "read"]);
    expect(offered(leaf)).toEqual(["read"]);
  });

  it("a child's mode is the same as its parent's or stricter, never looser", async () => {
    const cy = await as("cy");
    await cy.setMode({ mode: "bypassPermissions" });
    const parent = await cy.startSession({ project: "alpha", agent: "team/lead" });
    // A stricter mode for the child: dontAsk denies the write the user's mode would allow.
    const strict = await cy.sendMessage(parent.id, {
      content: start({
        agent: "team/careful",
        mode: "dontAsk",
        message: write(`/alpha/strict-${t}.md`),
      }),
    });
    expect(results(strict)[0]?.output).toMatch(/turn completed/);
    const careful = (await cy.listSessions()).sessions.find((s) => s.agent === "team/careful");
    const denied = (await cy.listItems(String(careful?.id))).items.filter(
      (i) => i.kind === "tool_result",
    );
    expect(denied).toEqual([expect.objectContaining({ isError: true })]);
    // A looser mode changes nothing: under the user's default mode the write still asks.
    await cy.setMode({ mode: "default" });
    const loose = await cy.sendMessage(parent.id, {
      content: start({
        agent: "team/loose",
        mode: "bypassPermissions",
        message: write(`/alpha/loose-${t}.md`),
      }),
    });
    expect(results(loose)[0]?.output).toMatch(/waiting on the user's approval/);
    // The parent itself still writes as the user's mode says (default asks).
    await cy.setMode({ mode: "bypassPermissions" });
    const own = await cy.sendMessage(parent.id, { content: write(`/alpha/own-${t}.md`) });
    expect(results(own)).toEqual([expect.objectContaining({ isError: false })]);
    // A mode the deployment doesn't know is refused.
    const unknown = await cy.sendMessage(parent.id, {
      content: start({ agent: "team/odd", mode: "noSuchMode", message: "hi" }),
    });
    expect(results(unknown)[0]).toMatchObject({ isError: true });
  });

  it("a sub-agent's approvals reach the root session's events stream and /v1/me", async () => {
    const dee = await as("dee");
    const root = await dee.startSession({ project: "alpha", agent: "team/lead" });
    const path = `/alpha/deep-${t}.md`;
    const turn = await dee.sendMessage(root.id, {
      content: start({
        agent: "team/helper",
        message: start({ agent: "team/writer", message: write(path, "deep\n") }),
      }),
    });
    expect(results(turn)[0]?.output).toMatch(/waiting on the user's approval/);
    const writer = (await dee.listSessions()).sessions.find((s) => s.agent === "team/writer");
    expect(writer).toMatchObject({ root: root.id });
    // Listed on /v1/me, as the grandchild's.
    const pending = (await dee.me()).approvals ?? [];
    const approval = pending.find((a) => a.session === writer?.id);
    expect(approval).toMatchObject({ action: { method: "write", path } });
    // Posted to the root session's events stream.
    const { events } = await dee.readEvents(root.id);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "approval.requested",
        data: expect.objectContaining({
          session: writer?.id,
          approvals: [expect.objectContaining({ id: approval?.id })],
        }),
      }),
    );
    // Answering it continues the grandchild, which writes.
    const answered = await dee.answerApproval(String(approval?.id), {
      decision: "allow",
      scope: "once",
    });
    const done = await dee.waitTurn(answered.accepted);
    expect(done.items.filter((i) => i.kind === "tool_result")).toEqual([
      expect.objectContaining({ isError: false }),
    ]);
  });

  it("archiving a session revokes it and its descendants; siblings keep running", async () => {
    const eli = await as("eli");
    const root = await eli.startSession({ project: "alpha", agent: "team/lead" });
    await eli.sendMessage(root.id, {
      content: start({
        agent: "team/doomed",
        message: start({ agent: "team/doomed-child", message: "hi" }),
      }),
    });
    await eli.sendMessage(root.id, { content: start({ agent: "team/sibling", message: "hi" }) });
    const byAgent = async (agent: string) =>
      (await eli.listSessions({ status: "archived" })).sessions
        .concat((await eli.listSessions()).sessions)
        .find((s) => s.agent === agent);
    const doomed = await byAgent("team/doomed");
    const under = await byAgent("team/doomed-child");
    const sibling = await byAgent("team/sibling");
    expect(under?.parent).toBe(doomed?.id);
    await eli.archiveSession(String(doomed?.id));
    for (const s of [doomed, under]) {
      expect(await eli.getSession(String(s?.id))).toMatchObject({
        revoked: true,
        archived: expect.any(Number),
      });
      // Its DO takes no more turns, even past the User DO.
      await expect(
        sendPastUser(deployment, ADMIN_KEY, String(s?.id), read("/alpha/readme.md")),
      ).rejects.toMatchObject({ status: 409 });
    }
    await expect(
      eli.sendMessage(String(under?.id), { content: read("/alpha/readme.md") }),
    ).rejects.toMatchObject({ status: expect.any(Number) });
    // The sibling and the root keep running.
    for (const s of [sibling, root]) {
      const turn = await eli.sendMessage(String(s?.id), { content: read("/alpha/readme.md") });
      expect(results(turn)).toEqual([expect.objectContaining({ isError: false })]);
    }
  });

  it("revoking the user session stops every agent session of the tree", async () => {
    const fay = await as("fay");
    const root = await fay.startSession({ project: "alpha", agent: "team/lead" });
    await fay.sendMessage(root.id, { content: start({ agent: "team/helper", message: "hi" }) });
    const child = (await fay.listSessions()).sessions.find((s) => s.parent === root.id);
    await fay.revokeUserSession();
    // The model gateway refuses a revoked capability before the model is asked (#134): no tool
    // runs, and the root starts no other sub-agent.
    for (const id of [root.id, String(child?.id)]) {
      const past = await sendPastUser(deployment, ADMIN_KEY, id, read("/alpha/readme.md"));
      expect(past).toMatchObject({ status: "failed", error: expect.stringMatching(/EACCES/) });
      expect(past.items.filter((i) => i.kind === "tool_result")).toEqual([]);
    }
    const again = await sendPastUser(
      deployment,
      ADMIN_KEY,
      root.id,
      start({ agent: "team/late", message: "hi" }),
    );
    expect(again).toMatchObject({ status: "failed", error: expect.stringMatching(/EACCES/) });
  });

  it("revoking a session stops its sub-agents at the gate, and not its siblings", async () => {
    const gus = await as("gus");
    const root = await gus.startSession({ project: "alpha", agent: "team/lead" });
    await gus.sendMessage(root.id, {
      content: start({
        agent: "team/cut",
        message: start({ agent: "team/cut-child", message: "hi" }),
      }),
    });
    await gus.sendMessage(root.id, { content: start({ agent: "team/kept", message: "hi" }) });
    const { sessions } = await gus.listSessions();
    const id = (agent: string) => String(sessions.find((s) => s.agent === agent)?.id);
    await gus.revokeSession(id("team/cut"));
    for (const agent of ["team/cut", "team/cut-child"]) {
      expect(await gus.getSession(id(agent))).toMatchObject({ revoked: true });
      const past = await sendPastUser(deployment, ADMIN_KEY, id(agent), read("/alpha/readme.md"));
      // Refused at the model gateway, before any tool runs (#134).
      expect(past).toMatchObject({ status: "failed", error: expect.stringMatching(/EACCES/) });
      expect(past.items.filter((i) => i.kind === "tool_result")).toEqual([]);
    }
    const kept = await gus.sendMessage(id("team/kept"), { content: read("/alpha/readme.md") });
    expect(results(kept)).toEqual([expect.objectContaining({ isError: false })]);
  });

  it("agents keep working after the user's access token expires; a new token resumes the same user session", async () => {
    const token = await login(deployment, u("hal"), { ttlMs: 1500 });
    const hal = await connect(deployment, token);
    await hal.setMode({ mode: "bypassPermissions" });
    const before = await hal.me();
    const session = await hal.startSession({ project: "alpha", agent: "team/lead" });
    const hold = `HOLD expiry-${t}`;
    const first = await hal.postMessage(session.id, { content: hold });
    // Queued behind the held turn: it runs once the token has expired, starting a sub-agent.
    const path = `/alpha/after-expiry-${t}.md`;
    const second = await hal.postMessage(session.id, {
      content: start({ agent: "team/late", message: write(path, "after\n") }),
    });
    await model.held(`expiry-${t}`);
    await sleep(1600);
    await expect(hal.listSessions()).rejects.toMatchObject({ status: 401 });
    model.release(`expiry-${t}`);
    const fresh = await connect(deployment, await login(deployment, u("hal")));
    expect((await fresh.waitTurn(first)).status).toBe("completed");
    const turn = await fresh.waitTurn(second);
    expect(results(turn)[0]?.output).toMatch(/turn completed/);
    // The same user session, which the sub-agent's write went through.
    expect((await fresh.me()).id).toBe(before.id);
    const check = await fresh.sendMessage(session.id, { content: read(path) });
    expect(results(check)).toEqual([
      expect.objectContaining({ isError: false, output: "after\n" }),
    ]);
  });

  it("starts only agents the parent's definition lists and the user may use", async () => {
    const ivy = await as("ivy");
    const lead = await ivy.startSession({ project: "alpha", agent: "team/lead" });
    // Listed by lead's definition, but ivy may not use it.
    const writer = await ivy.sendMessage(lead.id, {
      content: start({ agent: "team/writer", message: "hi" }),
    });
    expect(results(writer)[0]).toMatchObject({ isError: true });
    // Ivy may use it, and lead lists it.
    const helper = await ivy.sendMessage(lead.id, {
      content: start({ agent: "team/helper", message: "hi" }),
    });
    expect(results(helper)[0]).toMatchObject({ isError: false });
    const jo = await as("jo");
    const outsider = await jo.startSession({ project: "alpha", agent: "other/outsider" });
    // Jo may use it, but outsider's definition lists only team agents.
    const other = await jo.sendMessage(outsider.id, {
      content: start({ agent: "other/outsider", message: "hi" }),
    });
    expect(results(other)[0]).toMatchObject({ isError: true });
    expect((await jo.listSessions()).sessions.filter((s) => s.parent)).toEqual([]);
    // An agent that lists no sub-agents isn't offered agent.start at all.
    const solo = await jo.startSession({ project: "alpha", agent: "team/solo" });
    await jo.sendMessage(solo.id, { content: `solo ${t}` });
    expect(model.requests.find((r) => r.lastUserText === `solo ${t}`)?.tools).not.toContain(
      "agent_start",
    );
  });
});
