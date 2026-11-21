// The User DO (statewalker/statewalker-root#172, amending #78 and #89 by #157): one per user per
// deployment, holding the user's profile, the index of their agent sessions across workspaces, and
// their user sessions (one per workspace). Calls go only from a user to a workspace: the Workspace
// DO's gate takes user, project and session from the capability, never from the User DO. Run
// against the harness's own deployment (ai-host-do) on CellB Node in-process, with the scripted
// model, over REST and RPC.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Deployment,
  type FakeModel,
  fakeModel,
  login,
  makeUserUnreachable,
  restClient,
  rpcClient,
  type SessionClient,
  seed,
  seedProfiles,
  sendPastUser,
  startDeployment,
} from "../src/index.js";

const HOST = new URL("../../ai-host-do/", import.meta.url);
const ADMIN_KEY = "conformance-admin-key";

// Each transport gets its own users ("ann-rest", "ann-rpc"), so the two runs share no sessions.
const TRANSPORTS = ["rest", "rpc"];
const members = (roles: Record<string, string>) =>
  JSON.stringify(
    Object.fromEntries(
      TRANSPORTS.flatMap((t) =>
        Object.entries(roles).map(([user, role]) => [`${user}-${t}`, role]),
      ),
    ),
  );
const DEFAULT_FILES = {
  "/alpha/readme.md": "# alpha\n",
  "/alpha/.system/access": members({ ann: "editor", bob: "reader", cid: "reader", eve: "reader" }),
};
const OTHER_FILES = {
  "/gamma/readme.md": "# gamma, in the other workspace\n",
  "/gamma/.system/access": members({ ann: "owner" }),
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
    LLM_BASE_URL: model.url,
    DEV_LOGIN: "true",
    ADMIN_KEY,
    WORKSPACES: "default,other",
  });
  await seed(deployment, ADMIN_KEY, DEFAULT_FILES);
  await seed(deployment, ADMIN_KEY, OTHER_FILES, "other");
  await seedProfiles(
    deployment,
    ADMIN_KEY,
    Object.fromEntries(
      TRANSPORTS.flatMap((t) => [
        [`/profiles/ann-${t}/preferences/entries/p1.md`, "---\nid: p1\n---\nAnswer in French.\n"],
        [`/profiles/ann-${t}/projects/default/alpha/entries/u1.md`, "ann's note on alpha\n"],
        [`/profiles/ann-${t}/projects/other/gamma/entries/u2.md`, "ann's note on gamma\n"],
        [`/profiles/bob-${t}/projects/default/alpha/entries/u3.md`, "bob's note on alpha\n"],
        [`/profiles/eve-${t}/projects/default/alpha/entries/u4.md`, "eve's note on alpha\n"],
      ]),
    ),
  );
}, 120_000);
afterAll(async () => {
  for (const s of sockets) s.close();
  await deployment?.close();
  await model?.close();
});

describe.each(transports)("user DO over %s", (name, connect) => {
  const u = (user: string) => `${user}-${name.toLowerCase()}`;
  const as = async (user: string, workspace?: string) =>
    connect(deployment, await login(deployment, user, { workspace }));

  it("lists the caller's agent sessions in the token's workspace, from the session index", async () => {
    const ann = await as(u("ann"));
    expect(await ann.listSessions()).toEqual({ sessions: [] });
    const first = await ann.startSession({ project: "alpha", agent: "one" });
    const second = await ann.startSession({ project: "alpha", agent: "two" });
    const { sessions } = await ann.listSessions();
    expect(sessions.map((s) => [s.id, s.project, s.agent, s.workspace])).toEqual([
      [first.id, "alpha", "one", "default"],
      [second.id, "alpha", "two", "default"],
    ]);
    // The user session's capability and the agent sessions' stay on the server.
    expect(JSON.stringify([await ann.me(), sessions])).not.toMatch(/capabilit|Ei[A-Za-z0-9_-]{40}/);
  });

  it("lists another workspace's sessions only with a token for that workspace", async () => {
    const inDefault = await as(u("ann"));
    const inOther = await as(u("ann"), "other");
    const here = await inDefault.startSession({ project: "alpha", agent: "here" });
    const there = await inOther.startSession({ project: "gamma", agent: "there" });
    expect(there.workspace).toBe("other");
    const ids = async (c: SessionClient) => (await c.listSessions()).sessions.map((s) => s.id);
    expect(await ids(inDefault)).toContain(here.id);
    expect(await ids(inDefault)).not.toContain(there.id);
    expect(await ids(inOther)).toEqual([there.id]);
    // A session is reached only with a token for its own workspace.
    await expect(inDefault.listItems(there.id)).rejects.toMatchObject({ status: 404 });
    await expect(inOther.listItems(there.id)).resolves.toEqual({ items: [] });
    // One user session per workspace.
    expect((await inOther.me()).id).not.toBe((await inDefault.me()).id);
    expect(await inOther.me()).toMatchObject({ workspace: "other", mode: "default" });
  });

  it("refuses a token for a workspace the deployment does not serve", async () => {
    const res = await deployment.fetch("/v1/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user: u("ann"), workspace: "elsewhere" }),
    });
    const { token } = (await res.json()) as { token: string };
    await expect((await connect(deployment, token)).me()).rejects.toMatchObject({ status: 401 });
  });

  it("the gate answers an agent session's file calls while its User DO is unreachable", async () => {
    const cid = await as(u("cid"));
    const session = await cid.startSession({ project: "alpha", agent: "reader" });
    await makeUserUnreachable(deployment, ADMIN_KEY, u("cid"));
    await expect(cid.listSessions()).rejects.toMatchObject({ status: 500 });
    const read = `CALL read ${JSON.stringify({ path: "/alpha/readme.md" })}`;
    const turn = await sendPastUser(deployment, ADMIN_KEY, session.id, read);
    expect(turn.items.filter((i) => i.kind === "tool_result")).toEqual([
      expect.objectContaining({ isError: false, output: DEFAULT_FILES["/alpha/readme.md"] }),
    ]);
  });

  it("serves each user only their own folder of the profiles file system", async () => {
    expect(await (await as(u("ann"))).profile()).toEqual({
      user: u("ann"),
      projects: [
        { workspace: "default", project: "alpha" },
        { workspace: "other", project: "gamma" },
      ],
    });
    expect(await (await as(u("bob"))).profile()).toEqual({
      user: u("bob"),
      projects: [{ workspace: "default", project: "alpha" }],
    });
    // The profile belongs to the user, not the workspace: the same from a token for another one.
    expect((await (await as(u("ann"), "other")).profile()).projects).toHaveLength(2);
    expect(await (await as(u("dan"))).profile()).toEqual({ user: u("dan"), projects: [] });
  });

  it("refuses a user whose name would reach outside their own profile folder", async () => {
    for (const user of ["..", `../${u("bob")}`, `${u("ann")}/../${u("bob")}`]) {
      const client = await as(user);
      await expect(client.profile()).rejects.toMatchObject({ status: 400 });
      await expect(client.me()).rejects.toMatchObject({ status: 400 });
    }
  });

  it("erasing a user erases their profile and their User DO's storage", async () => {
    const eve = await as(u("eve"));
    const before = await eve.me();
    const session = await eve.startSession({ project: "alpha", agent: "doomed" });
    expect((await eve.profile()).projects).toHaveLength(1);
    expect(await eve.eraseUser()).toEqual({ erased: true });
    expect(await eve.profile()).toEqual({ user: u("eve"), projects: [] });
    expect(await eve.listSessions()).toEqual({ sessions: [] });
    await expect(eve.listItems(session.id)).rejects.toMatchObject({ status: 404 });
    // The next token opens a new user session; other users keep theirs.
    expect((await eve.me()).id).not.toBe(before.id);
    expect((await (await as(u("bob"))).profile()).projects).toHaveLength(1);
  });
});

it("a Workspace DO holds no way to call a User DO or the profiles", () => {
  // Behaviourally: the gate answers while the User DO is unreachable (above). Structurally: the
  // Workspace DO's code never names the User DO's or the Profiles DO's binding.
  const source = readFileSync(new URL("src/workspace-do.ts", HOST), "utf8");
  expect(source).not.toMatch(/\benv\.(USER|PROFILES)\b|\b(userOf|profilesOf)\(\s*(this\.)?env\b/);
});
