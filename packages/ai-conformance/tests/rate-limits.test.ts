// Rate limits (statewalker/statewalker-root#180, decision #158): limits with short periods
// (`second`, `minute`) and `on_exceed: delay`. The session API's messages, stream opens and
// session starts are limited per user (in the User DO) and per workspace (in the Workspace DO),
// 60 and 600 a minute by default; over the limit a request waits up to 30 s for its window, then
// is answered 429 with Retry-After. The deployment's provider keys get RPM/TPM limits with a share
// per workspace; over the share a request is delayed, a provider's 429 falls back to the next
// model, and with no model left the turn ends incomplete with `stop_reason: rate_limited`. The
// user's own keys get buckets in the User DO, from the user's own limits.
//
// Run against the harness's own deployment (ai-host-do) on CellB Node in-process, with the
// scripted model, over REST and RPC. The deployment's clock is a test clock (TEST_CLOCK) that
// stands still one second into a minute and moves only when a DO waits on a delay, so no
// scenario waits on, or races, the wall clock.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  advanceUserClock,
  advanceWorkspaceClock,
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
/** One second into a minute: a minute's window resets in 59 s, past the 30 s a request may wait. */
const CLOCK = Date.UTC(2026, 0, 1, 0, 0, 1);

const TRANSPORTS = ["rest", "rpc"];
const limits = (...list: Record<string, unknown>[]) => JSON.stringify(list);

/** The workspaces each transport's scenarios run in, so they share no counter. */
const WS = (t: string) => ({
  /** Default workspace limits (600 a minute). */
  open: `${t}-open`,
  /** A workspace limit of 4 a minute. */
  busy: `${t}-busy`,
  /** Another workspace, beside the busy one. */
  calm: `${t}-calm`,
  /** Two workspaces with a share of one request a minute each of the scripted provider. */
  p1: `${t}-p1`,
  p2: `${t}-p2`,
  /** A workspace limit of 2 a minute, for a user held to 2 a minute too. */
  stack: `${t}-stack`,
  /** A share of 5 requests and 50 tokens a minute of the scripted provider (a request takes 15). */
  tokens: `${t}-tokens`,
});

/** The users of the session API scenarios, each held to 3 requests a minute. */
const HELD = ["ann", "bob", "cid", "dan", "eve"];

const AP = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const CATALOG = {
  "/core/plugin.json": JSON.stringify({ $schema: AP, name: "core", version: "1.0.0" }),
  "/core/dev.cellb.harness/agents/plain.md": "---\nname: plain\n---\nPLAIN\n",
  "/core/dev.cellb.harness/agents/fallback.md":
    "---\nname: fallback\nmodels: [scripted/default, spare/small]\n---\nFALLBACK\n",
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
/** A deployment whose requests may wait a minute for their window (LIMITS_MAX_DELAY_MS). */
let patient: Deployment;

beforeAll(async () => {
  model = await fakeModel();
  const workspaces = TRANSPORTS.flatMap((t) => Object.values(WS(t)));
  deployment = await startDeployment(HOST, {
    DEV_LOGIN: "true",
    ADMIN_KEY,
    TEST_CLOCK: String(CLOCK),
    SECRETS_KEY: "conformance-secrets-key",
    USER_PROVIDER_HOSTS: "127.0.0.1",
    WORKSPACES: workspaces.join(","),
    CATALOG: JSON.stringify(CATALOG),
    DEFAULT_AGENT: "core/plain",
    MODELS: model.deploymentModels({
      // The deployment's key to the scripted provider: 100 requests and 1000 tokens a minute, of
      // which some workspaces get a share.
      provider: {
        rate: {
          rpm: 100,
          tpm: 1000,
          shares: Object.fromEntries(
            TRANSPORTS.flatMap((t) => [
              [WS(t).p1, 0.01],
              [WS(t).p2, 0.01],
              [WS(t).tokens, 0.05],
            ]),
          ),
        },
      },
      providers: [{ id: "spare" }],
      models: [{ id: "scripted/default", alias: "default" }, { id: "spare/small" }],
    }),
    LIMITS: limits(
      ...HELD.flatMap((user) =>
        TRANSPORTS.map((t) => ({
          meter: "api_requests",
          level: "user",
          target: `${user}-${t}`,
          value: 3,
          period: "minute",
          on_exceed: "delay",
        })),
      ),
      ...TRANSPORTS.flatMap((t) => [
        {
          meter: "api_requests",
          level: "user",
          target: `lou-${t}`,
          value: 2,
          period: "minute",
          on_exceed: "delay",
        },
        {
          meter: "api_requests",
          level: "workspace",
          target: WS(t).stack,
          value: 2,
          period: "minute",
          on_exceed: "delay",
        },
      ]),
      ...TRANSPORTS.map((t) => ({
        meter: "api_requests",
        level: "workspace",
        target: WS(t).busy,
        value: 4,
        period: "minute",
        on_exceed: "delay",
      })),
    ),
  });
  for (const workspace of workspaces)
    await seed(
      deployment,
      ADMIN_KEY,
      {
        "/work/.system/access": JSON.stringify(
          Object.fromEntries(
            [...HELD, "fay", "gus", "hal", "ivy", "jay", "kay", "lou"].flatMap((u) =>
              TRANSPORTS.map((t) => [`${u}-${t}`, "owner"]),
            ),
          ),
        ),
      },
      workspace,
    );
  patient = await startDeployment(HOST, {
    DEV_LOGIN: "true",
    ADMIN_KEY,
    TEST_CLOCK: String(CLOCK),
    LIMITS_MAX_DELAY_MS: "60000",
    MODELS: model.deploymentModels(),
    LIMITS: limits({
      meter: "api_requests",
      level: "user",
      value: 1,
      period: "minute",
      on_exceed: "delay",
    }),
  });
  await seed(patient, ADMIN_KEY, {
    "/work/.system/access": JSON.stringify(
      Object.fromEntries(TRANSPORTS.map((t) => [`ann-${t}`, "owner"])),
    ),
  });
}, 120_000);

afterAll(async () => {
  for (const s of sockets) s.close();
  await deployment?.close();
  await patient?.close();
  await model?.close();
});

describe.each(transports)("rate limits over %s", (name, connect) => {
  const t = name.toLowerCase();
  const ws = WS(t);
  const u = (user: string) => `${user}-${t}`;
  const as = async (user: string, workspace: string) =>
    connect(deployment, await login(deployment, u(user), { workspace }));

  it("answers 429 with Retry-After to session starts and messages over the user's limit", async () => {
    const ann = await as("ann", ws.open);
    const s = await ann.startSession({ project: "work" });
    await ann.postMessage(s.id, { content: "hello" });
    await ann.postMessage(s.id, { content: "hello" });
    await expect(ann.postMessage(s.id, { content: "hello" })).rejects.toMatchObject({
      status: 429,
      message: expect.stringContaining("api_requests"),
    });
    await expect(ann.startSession({ project: "work" })).rejects.toMatchObject({ status: 429 });
    // REST says when the minute's window resets.
    const res = await deployment.fetch("/v1/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${await login(deployment, u("ann"), { workspace: ws.open })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ project: "work" }),
    });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBe(59);
    // A stream opened is limited too; reading is not.
    const stream = await deployment.fetch(`/v1/sessions/${s.id}/events?since=0`, {
      headers: {
        authorization: `Bearer ${await login(deployment, u("ann"), { workspace: ws.open })}`,
      },
    });
    expect(stream.status).toBe(429);
    await ann.getSession(s.id);
  });

  it("limits the user across workspaces: the count is held in their User DO", async () => {
    const bob = await as("bob", ws.calm);
    await bob.startSession({ project: "work" });
    await bob.startSession({ project: "work" });
    const elsewhere = await as("bob", ws.p2);
    await elsewhere.startSession({ project: "work" });
    await expect(elsewhere.startSession({ project: "work" })).rejects.toMatchObject({
      status: 429,
    });
  });

  it("answers 429 over the workspace's limit, and a burst there holds no other workspace", async () => {
    const cid = await as("cid", ws.busy);
    const dan = await as("dan", ws.busy);
    await cid.startSession({ project: "work" });
    await cid.startSession({ project: "work" });
    await dan.startSession({ project: "work" });
    await dan.startSession({ project: "work" });
    await expect(dan.startSession({ project: "work" })).rejects.toMatchObject({
      status: 429,
      message: expect.stringContaining(ws.busy),
    });
    // A request the workspace refused is not counted against dan: in another workspace he starts
    // at once.
    const calm = await as("dan", ws.calm);
    await calm.startSession({ project: "work" });
  });

  it("delays a request whose window resets within 30 s, then admits it", async () => {
    // 45 s into the minute: the window resets in 15 s.
    await advanceUserClock(deployment, ADMIN_KEY, u("eve"), 44_000);
    const eve = await as("eve", ws.open);
    for (let i = 0; i < 3; i++) await eve.startSession({ project: "work" });
    // Waits (on the User DO's clock) for the next minute, and is admitted there.
    await eve.startSession({ project: "work" });
    await eve.startSession({ project: "work" });
    await eve.startSession({ project: "work" });
    // The next minute's window resets in about 60 s, past the 30 s: denied at once.
    await expect(eve.startSession({ project: "work" })).rejects.toMatchObject({ status: 429 });
  });

  it("delays requests over the workspace's share of a provider key, then ends the turn rate_limited", async () => {
    const fay = await as("fay", ws.p1);
    const s = await fay.startSession({ project: "work" });
    expect(await fay.sendMessage(s.id, { content: "hello" })).toMatchObject({
      status: "completed",
    });
    // The share's next window is 59 s away, past the 30 s a request may wait: no model is left.
    const turn = await fay.sendMessage(s.id, { content: "hello" });
    expect(turn).toMatchObject({
      status: "incomplete",
      stop_reason: { type: "rate_limited", message: expect.stringContaining("model_requests") },
    });
    // The burst in p1 holds no other workspace: p2's share is its own.
    const gus = await as("gus", ws.p2);
    const other = await gus.startSession({ project: "work" });
    expect(await gus.sendMessage(other.id, { content: "hello" })).toMatchObject({
      status: "completed",
    });
  });

  it("falls back to the agent's next model when the share is used up", async () => {
    const hal = await as("hal", ws.p2);
    const s = await hal.startSession({ project: "work", agent: "core/fallback" });
    // gus took p2's one request of the minute (scenarios run in order).
    const turn = await hal.sendMessage(s.id, { content: "hello" });
    expect(turn.status).toBe("completed");
    expect(turn.items.find((i) => i.kind === "model_fallback")).toMatchObject({
      from: "scripted/default",
      to: "spare/small",
      reason: "rate_limited",
    });
  });

  it("holds a workspace to its share of the provider's tokens a minute", async () => {
    const ivy = await as("ivy", ws.tokens);
    const s = await ivy.startSession({ project: "work" });
    // Four requests of 15 tokens take 60 of the 50: the fifth finds none left, with requests left.
    for (let i = 0; i < 4; i++)
      expect(await ivy.sendMessage(s.id, { content: "hello" })).toMatchObject({
        status: "completed",
      });
    expect(await ivy.sendMessage(s.id, { content: "hello" })).toMatchObject({
      status: "incomplete",
      stop_reason: { type: "rate_limited", message: expect.stringContaining("model_tokens") },
    });
  });

  it("falls back on a provider's 429, and ends the turn rate_limited when no model is left", async () => {
    const fay = await as("fay", ws.open);
    const s = await fay.startSession({ project: "work" });
    model.fail("default", 429);
    try {
      const turn = await fay.sendMessage(s.id, { content: "hello" });
      expect(turn).toMatchObject({ status: "incomplete", stop_reason: { type: "rate_limited" } });
      const fallback = await fay.startSession({ project: "work", agent: "core/fallback" });
      const served = await fay.sendMessage(fallback.id, { content: "hello" });
      expect(served.status).toBe("completed");
      expect(served.items.find((i) => i.kind === "model_fallback")).toMatchObject({
        reason: "rate_limited",
        to: "spare/small",
      });
    } finally {
      model.heal("default");
    }
  });

  it("holds the user's own key to the buckets they set, in their User DO", async () => {
    const jay = await as("jay", ws.open);
    await jay.setSecret({
      level: "user",
      name: "JAY_KEY",
      value: "jay-model-key",
      bindings: { plugins: ["model-gateway"], hosts: ["127.0.0.1"] },
    });
    await jay.setModelConfig({
      providers: [{ id: "jays", api: "openai-completions", baseUrl: model.url, secret: "JAY_KEY" }],
      models: [{ id: "jays/own" }],
    });
    await jay.setLimits("user", u("jay"), {
      limits: [{ meter: "model_requests", value: 1, period: "minute", on_exceed: "delay" }],
    });
    const s = await jay.startSession({ project: "work", model: "jays/own" });
    expect(await jay.sendMessage(s.id, { content: "hello" })).toMatchObject({
      status: "completed",
    });
    expect(await jay.sendMessage(s.id, { content: "hello" })).toMatchObject({
      status: "incomplete",
      stop_reason: {
        type: "rate_limited",
        limit: { meter: "model_requests", level: "user", target: u("jay"), value: 1 },
      },
    });
    // The bucket holds the user's own key only: the deployment's models still run for jay.
    const deployed = await jay.startSession({ project: "work" });
    expect(await jay.sendMessage(deployed.id, { content: "hello" })).toMatchObject({
      status: "completed",
    });
    // Their buckets show among their effective limits.
    expect((await jay.effectiveLimits()).limits).toContainEqual(
      expect.objectContaining({ meter: "model_requests", level: "user", used: 1, remaining: 0 }),
    );
  });

  it("waits as long as the deployment's max delay allows", async () => {
    const ann = await connect(patient, await login(patient, u("ann")));
    await ann.startSession({ project: "work" });
    // 59 s to the next window: within LIMITS_MAX_DELAY_MS (60 s), so it waits, and is admitted.
    await ann.startSession({ project: "work" });
    // It was admitted in the next minute's window, on the User DO's clock.
    expect((await ann.effectiveLimits()).limits).toContainEqual(
      expect.objectContaining({
        meter: "api_requests",
        level: "user",
        used: 1,
        reset: CLOCK - 1000 + 120_000,
      }),
    );
  });

  it("holds every user to 60 requests a minute, and every workspace to 600, by default", async () => {
    const kay = await as("kay", ws.calm);
    const effective = (await kay.effectiveLimits()).limits.filter(
      (l) => l.meter === "api_requests",
    );
    expect(effective).toContainEqual(
      expect.objectContaining({ level: "user", value: 60, period: "minute", on_exceed: "delay" }),
    );
    expect(effective).toContainEqual(
      expect.objectContaining({ level: "workspace", target: ws.calm, value: 600 }),
    );
    const s = await kay.startSession({ project: "work" });
    // A message to an archived session is refused (409), but counted: it was asked for.
    await kay.archiveSession(s.id);
    for (let i = 1; i < 60; i++)
      await expect(kay.postMessage(s.id, { content: "hello" })).rejects.toMatchObject({
        status: 409,
      });
    await expect(kay.postMessage(s.id, { content: "hello" })).rejects.toMatchObject({
      status: 429,
      message: expect.stringContaining("60 api_requests per minute"),
    });
  });

  it("waits 30 s in all, however many levels delay a request", async () => {
    const lou = await as("lou", ws.stack);
    await lou.startSession({ project: "work" });
    await lou.startSession({ project: "work" });
    // Both the user's window (their User DO's clock) and the workspace's reset in 20 s.
    await advanceUserClock(deployment, ADMIN_KEY, u("lou"), 39_000);
    await advanceWorkspaceClock(deployment, ADMIN_KEY, ws.stack, 39_000);
    // The user's level waits 20 s; the 10 s left are less than the workspace's 20: denied.
    await expect(lou.startSession({ project: "work" })).rejects.toMatchObject({
      status: 429,
      message: expect.stringContaining(ws.stack),
    });
  });
});
