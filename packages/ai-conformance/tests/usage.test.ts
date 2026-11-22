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
});
