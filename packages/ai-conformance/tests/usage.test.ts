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
    MODELS: model.deploymentModels({
      models: [
        { id: "scripted/default", alias: "default" },
        // One currency unit per output token, at most 10 of them: a request really costs 3.
        { id: "scripted/priced", maxTokens: 10, cost: { input: 0, output: 1_000_000 } },
      ],
    }),
  });
  await seed(deployment, ADMIN_KEY, FILES);
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
      expect.objectContaining({ key: {}, usage: expect.objectContaining({ turns: 1, model_spend: 3 }) }),
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
    const report = await boss.usage({ level: "workspace", period: "day", group_by: ["project", "user"] });
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
    expect(owner.groups).toContainEqual({ key: { user: u("kim"), model: "kims/own" }, own_key: true });
    expect(owner.groups.some((g) => g.key.model === "kims/own" && g.usage)).toBe(false);
    const admin = await (await as("boss")).usage({ level: "workspace", period: "day", group_by: ["user"] });
    const kims = admin.groups.filter((g) => g.key.user === u("kim"));
    expect(kims).toContainEqual({ key: { user: u("kim") }, own_key: true });
    expect(kims.some((g) => g.usage?.model_spend)).toBe(false);
  });
});
