// Reporting and managing usage and limits (statewalker/statewalker-root#181, decision #158): the
// effective limits of the caller's context, usage reports by level and group, the limits each
// level's managers set, the NDJSON export of usage records, and usage on the user's own key seen
// by that user alone. Run against the harness's own deployment (ai-host-do) on CellB Node
// in-process, with the scripted model, over REST and RPC.
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
} from "../src/index.js";

const HOST = new URL("../../ai-host-do/", import.meta.url);
const ADMIN_KEY = "conformance-admin-key";
const OPERATOR_KEY = "conformance-operator-key";

const TRANSPORTS = ["rest", "rpc"];

const limits = (...list: Record<string, unknown>[]) => JSON.stringify(list);

const perTransport = (roles: Record<string, string>) =>
  JSON.stringify(
    Object.fromEntries(
      TRANSPORTS.flatMap((t) => Object.entries(roles).map(([u, r]) => [`${u}-${t}`, r])),
    ),
  );

/** Each transport's own projects, so scenarios don't share counters. */
function projectFiles(t: string): Record<string, string> {
  return {
    [`/rep-${t}/.system/access`]: JSON.stringify({ [`ann-${t}`]: "owner", [`bob-${t}`]: "editor" }),
    [`/use-${t}/.system/access`]: JSON.stringify({
      [`ann-${t}`]: "owner",
      [`bob-${t}`]: "editor",
      [`cid-${t}`]: "editor",
    }),
    [`/own-${t}/.system/access`]: JSON.stringify({ [`ann-${t}`]: "owner", [`kim-${t}`]: "editor" }),
    [`/as-team-${t}/.system/access`]: JSON.stringify({ [`ann-${t}`]: "owner" }),
    [`/mgr-${t}/.system/access`]: JSON.stringify({ [`ann-${t}`]: "owner", [`dan-${t}`]: "editor" }),
    [`/rep-${t}/.system/limits`]: limits({
      meter: "turns",
      level: "project",
      value: 10,
      period: "day",
    }),
  };
}

const FILES: Record<string, string> = {
  "/.system/access": perTransport({ boss: "admin" }),
  "/.system/limits": limits(
    ...TRANSPORTS.map((t) => ({
      meter: "turns",
      level: "member",
      target: `bob-${t}`,
      value: 5,
      period: "day",
    })),
  ),
  ...Object.fromEntries(TRANSPORTS.flatMap((t) => Object.entries(projectFiles(t)))),
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
    DEV_LOGIN: "true",
    ADMIN_KEY,
    SECRETS_KEY: "conformance-secrets-key",
    USER_PROVIDER_HOSTS: "127.0.0.1",
    OPERATOR_KEY,
    WORKSPACES: "default,other",
    MODELS: model.deploymentModels({
      models: [
        { id: "scripted/default", alias: "default" },
        // One currency unit per output token, at most 10 of them: a request really costs 3.
        { id: "scripted/priced", maxTokens: 10, cost: { input: 0, output: 1_000_000 } },
      ],
    }),
  });
  await seed(deployment, ADMIN_KEY, FILES);
  await seed(
    deployment,
    ADMIN_KEY,
    { "/far/.system/access": JSON.stringify({ zed: "owner" }) },
    "other",
  );
}, 120_000);
afterAll(async () => {
  for (const s of sockets) s.close();
  await deployment?.close();
  await model?.close();
});

describe.each(transports)("usage and limits over %s", (name, connect) => {
  const t = name.toLowerCase();
  const u = (user: string) => `${user}-${t}`;
  const as = async (user: string) => connect(deployment, await login(deployment, u(user)));

  it("answers each limit of the caller's context with used, reserved, remaining and reset", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({
      project: `rep-${t}`,
      limits: [{ meter: "tool_calls", value: 3, period: "total" }],
    });
    await ann.sendMessage(s.id, { content: "hello" });
    const before = Date.now();
    const { limits: found } = await ann.effectiveLimits({ project: `rep-${t}`, session: s.id });
    const turns = found.find((l) => l.meter === "turns" && l.level === "project");
    expect(turns).toMatchObject({
      target: `rep-${t}`,
      period: "day",
      value: 10,
      used: 1,
      reserved: 0,
      remaining: 9,
    });
    expect(Number(turns?.reset) > before && Number(turns?.reset) <= before + 86_400_000).toBe(true);
    expect(found.find((l) => l.level === "session")).toMatchObject({
      meter: "tool_calls",
      target: s.id,
      value: 3,
      used: 0,
      remaining: 3,
    });
    expect(found.find((l) => l.level === "session")?.reset).toBeUndefined();
    // Another member's own limit is not in ann's context; bob sees his.
    expect(found.some((l) => l.level === "member")).toBe(false);
    const bob = await as("bob");
    const mine = await bob.effectiveLimits({ project: `rep-${t}` });
    expect(mine.limits.find((l) => l.level === "member")).toMatchObject({
      meter: "turns",
      target: u("bob"),
      value: 5,
      used: 0,
    });
  });

  it("totals each turn's model usage on the turn, and the session's on the session", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project: `rep-${t}`, model: "scripted/priced" });
    const first = await ann.sendMessage(s.id, { content: "hello" });
    expect(first.usage).toMatchObject({ requests: 1, cost: 3, output_tokens: 3 });
    await ann.sendMessage(s.id, { content: "hello" });
    expect((await ann.getTurn(first.id)).usage).toMatchObject({ requests: 1, cost: 3 });
    expect((await ann.getSession(s.id)).usage).toMatchObject({
      requests: 2,
      cost: 6,
      output_tokens: 6,
    });
    // A fork copies the history, not the spend: its own total starts empty.
    const { session: fork } = await ann.forkSession(s.id, { at_turn: first.id });
    expect((await ann.getSession(fork.id)).usage).toBeUndefined();
  });

  it("reports each user's own usage, and a project's to those with usage.read:project", async () => {
    const bob = await as("bob");
    const cid = await as("cid");
    const ann = await as("ann");
    const s = await bob.startSession({ project: `use-${t}`, model: "scripted/priced" });
    await bob.sendMessage(s.id, { content: "hello" });
    const c = await cid.startSession({ project: `use-${t}`, model: "scripted/priced" });
    await cid.sendMessage(c.id, { content: "hello" });
    await cid.sendMessage(c.id, { content: "hello" });
    // Everyone sees their own usage in the workspace.
    const own = await bob.usage({ period: "day" });
    expect(own).toMatchObject({ level: "user", target: u("bob"), period: "day" });
    expect(own.groups).toEqual([
      expect.objectContaining({
        key: {},
        usage: expect.objectContaining({ turns: 1, model_spend: 3 }),
      }),
    ]);
    const byAgent = await bob.usage({ period: "day", group_by: ["agent", "model"] });
    expect(byAgent.groups).toContainEqual(
      expect.objectContaining({
        key: { agent: s.agent, model: "scripted/priced" },
        usage: expect.objectContaining({ model_spend: 3 }),
      }),
    );
    // An editor holds no usage.read:project.
    await expect(
      bob.usage({ level: "project", project: `use-${t}`, period: "day" }),
    ).rejects.toMatchObject({ status: 403 });
    // The owner does: the project's usage per member.
    const project = await ann.usage({
      level: "project",
      project: `use-${t}`,
      period: "day",
      group_by: ["user"],
    });
    expect(project).toMatchObject({ level: "project", target: `use-${t}` });
    expect(project.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: { user: u("bob") },
          usage: expect.objectContaining({ turns: 1, model_spend: 3 }),
        }),
        expect.objectContaining({
          key: { user: u("cid") },
          usage: expect.objectContaining({ turns: 2, model_spend: 6 }),
        }),
      ]),
    );
    const today = new Date().toISOString().slice(0, 10);
    const byDay = await ann.usage({
      level: "project",
      project: `use-${t}`,
      period: "month",
      group_by: ["day"],
    });
    expect(byDay.groups.map((g) => g.key.day)).toContain(today);
  });

  it("reports the workspace's usage per project and member to the workspace admin alone", async () => {
    const boss = await as("boss");
    const ann = await as("ann");
    const s = await ann.startSession({ project: `use-${t}` });
    await ann.sendMessage(s.id, { content: "hello" });
    const report = await boss.usage({
      level: "workspace",
      period: "day",
      group_by: ["project", "user"],
    });
    expect(report).toMatchObject({ level: "workspace", target: "default" });
    expect(report.groups).toContainEqual(
      expect.objectContaining({
        key: { project: `use-${t}`, user: u("ann") },
        usage: expect.objectContaining({ turns: expect.any(Number) }),
      }),
    );
    // The admin reads any project's usage through usage.read:workspace, without being a member.
    await boss.usage({ level: "project", project: `use-${t}`, period: "day" });
    // An owner holds no usage.read:workspace.
    await expect(ann.usage({ level: "workspace" })).rejects.toMatchObject({ status: 403 });
  });

  it("shows usage under a user's own key to that user alone: others see 'own key' without amounts", async () => {
    const kim = await as("kim");
    await kim.setSecret({
      level: "user",
      name: "KIM_KEY",
      value: "kim-model-key",
      bindings: { plugins: ["model-gateway"], hosts: ["127.0.0.1"] },
    });
    await kim.setModelConfig({
      providers: [{ id: "kims", api: "openai-completions", baseUrl: model.url, secret: "KIM_KEY" }],
      models: [{ id: "kims/own", maxTokens: 10, cost: { input: 0, output: 1_000_000 } }],
    });
    const s = await kim.startSession({ project: `own-${t}`, model: "kims/own" });
    await kim.sendMessage(s.id, { content: "hello" });
    const mine = await kim.usage({ period: "day", group_by: ["model"] });
    expect(mine.groups).toContainEqual({
      key: { model: "kims/own" },
      own_key: true,
      usage: expect.objectContaining({ model_spend: 3 }),
    });
    const owner = await (await as("ann")).usage({
      level: "project",
      project: `own-${t}`,
      period: "day",
      group_by: ["user", "model"],
    });
    expect(owner.groups).toContainEqual({
      key: { user: u("kim"), model: "kims/own" },
      own_key: true,
    });
    expect(owner.groups.some((g) => g.key.model === "kims/own" && g.usage)).toBe(false);
    const admin = await (await as("boss")).usage({
      level: "workspace",
      period: "day",
      group_by: ["user"],
    });
    const kims = admin.groups.filter((g) => g.key.user === u("kim"));
    expect(kims).toContainEqual({ key: { user: u("kim") }, own_key: true });
    expect(kims.some((g) => g.usage?.model_spend)).toBe(false);
  });

  it("lets the workspace admin manage workspace, project and member limits, and no one else", async () => {
    const boss = await as("boss");
    const ann = await as("ann");
    const dan = await as("dan");
    const turns = (value: number) => [{ meter: "turns", value, period: "day" }];
    expect(await boss.setLimits("member", u("dan"), { limits: turns(2) })).toMatchObject({
      level: "member",
      target: u("dan"),
      limits: [expect.objectContaining({ meter: "turns", value: 2, level: "member" })],
    });
    expect(
      (await dan.effectiveLimits({ project: `mgr-${t}` })).limits.find((l) => l.level === "member"),
    ).toMatchObject({ meter: "turns", value: 2, target: u("dan") });
    expect((await boss.getLimits("member", u("dan"))).limits).toHaveLength(1);
    await expect(ann.setLimits("member", u("dan"), { limits: turns(50) })).rejects.toMatchObject({
      status: 403,
    });
    await boss.deleteLimits("member", u("dan"));
    expect(
      (await dan.effectiveLimits({ project: `mgr-${t}` })).limits.some((l) => l.level === "member"),
    ).toBe(false);
    // A workspace limit, and a malformed one refused.
    await boss.setLimits("workspace", "default", {
      limits: [{ meter: "sessions", value: 10_000 }],
    });
    expect((await boss.getLimits("workspace", "default")).limits).toEqual([
      expect.objectContaining({ meter: "sessions", value: 10_000 }),
    ]);
    await expect(
      boss.setLimits("workspace", "default", { limits: [{ meter: "nope", value: 1 }] }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(ann.getLimits("workspace", "default")).rejects.toMatchObject({ status: 403 });
  });

  it("lets owners set project and session limits within the admin's, which they cannot lift", async () => {
    const boss = await as("boss");
    const ann = await as("ann");
    const dan = await as("dan");
    const p = `mgr-${t}`;
    await boss.setLimits("project", p, { limits: [{ meter: "turns", value: 100, period: "day" }] });
    await ann.setLimits("project", p, { limits: [{ meter: "turns", value: 50, period: "day" }] });
    const values = async () =>
      (await ann.effectiveLimits({ project: p })).limits
        .filter((l) => l.level === "project" && l.meter === "turns")
        .map((l) => l.value)
        .sort((a, b) => a - b);
    expect(await values()).toEqual([50, 100]);
    // The owner removes their own limit, never the admin's.
    await ann.deleteLimits("project", p);
    expect(await values()).toEqual([100]);
    // Session defaults of the project: every new session starts with them.
    await ann.setLimits("session", p, {
      limits: [{ meter: "tool_calls", value: 4, period: "total" }],
    });
    const s = await dan.startSession({ project: p });
    expect(
      (await dan.effectiveLimits({ session: s.id })).limits.find((l) => l.level === "session"),
    ).toMatchObject({ meter: "tool_calls", value: 4, target: s.id });
    // An editor manages neither.
    await expect(
      dan.setLimits("project", p, { limits: [{ meter: "turns", value: 1000, period: "day" }] }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(dan.deleteLimits("session", p)).rejects.toMatchObject({ status: 403 });
    await ann.deleteLimits("session", p);
    await boss.deleteLimits("project", p);
  });

  it("lets users limit their own sessions and keys, without lifting the defaults they started with", async () => {
    const ann = await as("ann");
    const dan = await as("dan");
    const p = `mgr-${t}`;
    await ann.setLimits("session", p, {
      limits: [{ meter: "tool_calls", value: 4, period: "total" }],
    });
    const s = await dan.startSession({ project: p });
    await ann.deleteLimits("session", p);
    await dan.setLimits("session", s.id, { limits: [{ meter: "turns", value: 1 }] });
    const session = async () =>
      (await dan.effectiveLimits({ session: s.id })).limits
        .filter((l) => l.level === "session")
        .map((l) => `${l.meter}:${l.value}`)
        .sort();
    expect(await session()).toEqual(["tool_calls:4", "turns:1"]);
    expect((await dan.getLimits("session", s.id)).limits).toEqual([
      expect.objectContaining({ meter: "turns", value: 1, level: "session" }),
    ]);
    await dan.sendMessage(s.id, { content: "hello" });
    await expect(dan.postMessage(s.id, { content: "hello" })).rejects.toMatchObject({
      status: 429,
    });
    // Removing their own limits leaves the defaults.
    await dan.deleteLimits("session", s.id);
    expect(await session()).toEqual(["tool_calls:4"]);
    // Only the session's own user manages it.
    await expect(
      ann.setLimits("session", s.id, { limits: [{ meter: "turns", value: 1 }] }),
    ).rejects.toMatchObject({ status: 404 });
    // The user's own keys: their user limits, and no one else's.
    await dan.setLimits("user", u("dan"), {
      limits: [{ meter: "model_spend", value: 5, period: "month" }],
    });
    expect((await dan.effectiveLimits()).limits.find((l) => l.level === "user")).toMatchObject({
      meter: "model_spend",
      value: 5,
      target: u("dan"),
    });
    expect((await dan.getLimits("user", u("dan"))).limits).toHaveLength(1);
    await expect(
      dan.setLimits("user", u("ann"), { limits: [{ meter: "model_spend", value: 5 }] }),
    ).rejects.toMatchObject({ status: 403 });
    await dan.deleteLimits("user", u("dan"));
    expect((await dan.effectiveLimits()).limits.some((l) => l.level === "user")).toBe(false);
  });

  it("exports the workspace's usage records as NDJSON to its admin alone", async () => {
    const boss = await as("boss");
    const ann = await as("ann");
    const since = Date.now();
    const s = await ann.startSession({ project: `use-${t}`, model: "scripted/priced" });
    const turn = await ann.sendMessage(s.id, { content: "hello" });
    const records = await boss.usageRecords({ since });
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspace: "default",
          project: `use-${t}`,
          user: u("ann"),
          session: s.id,
          meter: "turns",
          amount: 1,
        }),
        expect.objectContaining({ session: s.id, turn: turn.id, meter: "model_spend", amount: 3 }),
      ]),
    );
    expect(records.every((r) => Number(r.created) >= since)).toBe(true);
    await expect(ann.usageRecords({ since })).rejects.toMatchObject({ status: 403 });
    if (t === "rest") {
      const res = await deployment.fetch(`/v1/usage/records?since=${since}`, {
        headers: { authorization: `Bearer ${await login(deployment, u("boss"))}` },
      });
      expect(res.headers.get("content-type")).toContain("application/x-ndjson");
      const lines = (await res.text()).split("\n").filter(Boolean);
      expect(lines.length).toBe(records.length);
    }
  });
  it("manages the session defaults of a project whose name looks like a session's", async () => {
    const ann = await as("ann");
    const p = `as-team-${t}`;
    await ann.setLimits("session", p, { limits: [{ meter: "turns", value: 3 }] });
    expect((await ann.getLimits("session", p)).limits).toEqual([
      expect.objectContaining({ meter: "turns", value: 3 }),
    ]);
    await ann.deleteLimits("session", p);
  });
});

describe("usage records for the operator", () => {
  const exportAs = (key: string, query = "since=0") =>
    deployment.fetch(`/v1/usage/records?${query}`, { headers: { authorization: `Bearer ${key}` } });

  it("exports every workspace's records with the operator token, and nothing to a wrong one", async () => {
    const zed = restClient(deployment, await login(deployment, "zed", { workspace: "other" }));
    const s = await zed.startSession({ project: "far" });
    await zed.sendMessage(s.id, { content: "hello" });
    const res = await exportAs(OPERATOR_KEY);
    expect(res.status).toBe(200);
    const records = (await res.text())
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(new Set(records.map((r) => r.workspace))).toEqual(new Set(["default", "other"]));
    expect(records).toContainEqual(
      expect.objectContaining({ workspace: "other", session: s.id, meter: "turns" }),
    );
    // One workspace only.
    const one = await (await exportAs(OPERATOR_KEY, "since=0&workspace=other")).text();
    expect(
      one
        .split("\n")
        .filter(Boolean)
        .every((l) => JSON.parse(l).workspace === "other"),
    ).toBe(true);
    expect((await exportAs("not-the-key")).status).toBe(401);
    // The admin of a workspace sees only theirs.
    const boss = restClient(deployment, await login(deployment, "boss-rest"));
    const theirs = await boss.usageRecords({ since: 0 });
    expect(theirs.some((r) => r.workspace === "other")).toBe(false);
  });
});
