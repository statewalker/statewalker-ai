// The model gateway (statewalker/statewalker-root#134, decision #105): providers and models
// configured at deployment, workspace, project and user level; a session's model picked from the
// agent's list within the user's rights, then the defaults, and pinned; fallback on overload,
// rate-limit and unavailable errors; every request metered, the user's own provider uncharged;
// provider keys injected by the secrets gateway. Run against the harness's own deployment
// (ai-host-do) on CellB Node in-process, with the scripted model, over REST and RPC.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Deployment,
  type FakeModel,
  fakeModel,
  type Item,
  login,
  modelUsage,
  restClient,
  rpcClient,
  type SessionClient,
  seed,
  startDeployment,
  type Turn,
} from "../src/index.js";

const HOST = new URL("../../ai-host-do/", import.meta.url);
const ADMIN_KEY = "conformance-admin-key";
const DEPLOY_KEY = "deploy-model-key-5c1e";
const USER_KEY = "user-model-key-93ab";
const PRICES = { input: 1_000_000, output: 2_000_000, cacheRead: 500_000, cacheWrite: 0 };

const AP = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const agent = (name: string, models?: string[]) =>
  [
    "---",
    `name: ${name}`,
    ...(models ? [`models: [${models.join(", ")}]`] : []),
    "---",
    `${name.toUpperCase()}-INSTRUCTIONS`,
    "",
  ].join("\n");

const CATALOG = {
  "/core/plugin.json": JSON.stringify({ $schema: AP, name: "core", version: "1.0.0" }),
  "/core/dev.cellb.harness/agents/plain.md": agent("plain"),
  "/core/dev.cellb.harness/agents/picky.md": agent("picky", ["nowhere/none", "smart", "fast"]),
  "/core/dev.cellb.harness/agents/fallback.md": agent("fallback", [
    "scripted/big",
    "scripted/small",
  ]),
  "/core/dev.cellb.harness/agents/fallback-unbound.md": agent("fallback-unbound", [
    "scripted/big",
    "unbound/unbound-v1",
  ]),
};

const TRANSPORTS = ["rest", "rpc"];

/** Each transport's own projects and users, so scenarios don't share configuration. */
function projectFiles(t: string): Record<string, string> {
  const access = (extra: Record<string, string> = {}) =>
    JSON.stringify({ [`ann-${t}`]: "owner", [`cus-${t}`]: "limited", ...extra });
  const roles = JSON.stringify({
    limited:
      "files.read, files.list, agents.use:core/*, models.use:fast, models.use:default, models.use:scripted/big, models.use:scripted/small",
    nomodels: "files.read, files.list, agents.use:core/*",
  });
  return {
    [`/alpha-${t}/.system/access`]: access(),
    [`/alpha-${t}/.system/roles`]: roles,
    // The project serves `fast` with its own model, and makes it its default.
    [`/alpha-${t}/.system/models`]: JSON.stringify({
      models: [{ id: "scripted/fast-v3", alias: "fast" }],
      default: "fast",
    }),
    [`/beta-${t}/.system/access`]: access(),
    [`/beta-${t}/.system/roles`]: roles,
    // Narrowed: only the default and `fast` stay.
    [`/narrow-${t}/.system/access`]: access(),
    [`/narrow-${t}/.system/roles`]: roles,
    [`/narrow-${t}/.system/models`]: JSON.stringify({ allow: ["default", "fast"] }),
    [`/closed-${t}/.system/access`]: JSON.stringify({ [`ann-${t}`]: "nomodels" }),
    [`/closed-${t}/.system/roles`]: roles,
    [`/pinned-${t}/.system/access`]: access(),
    [`/pinned-${t}/.system/models`]: JSON.stringify({ default: "scripted/default" }),
  };
}

const FILES: Record<string, string> = {
  // The workspace serves `fast` with another model, and makes it the workspace's default.
  "/.system/models": JSON.stringify({
    models: [{ id: "scripted/fast-v2", alias: "fast" }],
    default: "scripted/fast-v2",
  }),
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
  const config = JSON.parse(model.deploymentModels()) as { providers: unknown[] };
  deployment = await startDeployment(HOST, {
    DEV_LOGIN: "true",
    ADMIN_KEY,
    WORKSPACES: "default,other",
    SECRETS_KEY: "conformance-secrets-key",
    USER_PROVIDER_HOSTS: "127.0.0.1",
    DEPLOY_MODEL_KEY: DEPLOY_KEY,
    FIXTURE_KEY: "fixture-key-0d0d",
    DEPLOYMENT_SECRETS: JSON.stringify({
      DEPLOY_MODEL_KEY: { plugins: ["model-gateway"], hosts: ["127.0.0.1"] },
      // Bound to another plugin: the gateway never sends it to a model.
      FIXTURE_KEY: { plugins: ["fixture"], hosts: ["127.0.0.1"] },
    }),
    CATALOG: JSON.stringify(CATALOG),
    DEFAULT_AGENT: "core/plain",
    MODELS: JSON.stringify({
      providers: [
        ...config.providers,
        { id: "keyed", api: "openai-completions", baseUrl: model.url, secret: "DEPLOY_MODEL_KEY" },
        { id: "unbound", api: "openai-completions", baseUrl: model.url, secret: "FIXTURE_KEY" },
      ],
      models: [
        { id: "scripted/default", alias: "default" },
        { id: "scripted/fast-v1", alias: "fast" },
        { id: "scripted/smart-v1", alias: "smart", cost: PRICES },
        { id: "scripted/big" },
        { id: "scripted/small" },
        { id: "keyed/keyed-v1" },
        { id: "unbound/unbound-v1" },
      ],
      default: "scripted/default",
    }),
  });
  await seed(deployment, ADMIN_KEY, FILES);
  await seed(
    deployment,
    ADMIN_KEY,
    Object.fromEntries(
      TRANSPORTS.map((t) => [
        `/gamma-${t}/.system/access`,
        JSON.stringify({ [`ann-${t}`]: "owner" }),
      ]),
    ),
    "other",
  );
}, 120_000);
afterAll(async () => {
  for (const s of sockets) s.close();
  await deployment?.close();
  await model?.close();
});

const answerItem = (turn: Turn): Item | undefined =>
  turn.items.find((i) => i.kind === "message" && i.role === "assistant");

describe.each(transports)("the model gateway over %s", (name, connect) => {
  const t = name.toLowerCase();
  const u = (user: string) => `${user}-${t}`;
  const as = async (user: string, workspace?: string) =>
    connect(deployment, await login(deployment, u(user), workspace ? { workspace } : {}));
  const lastModel = () => model.requests.at(-1)?.model;

  it("runs a session on the first configured and allowed model in the agent's list", async () => {
    // cus holds no right to `smart`, and `nowhere/none` is configured nowhere: `fast` it is,
    // served in beta by the workspace's model.
    const cus = await as("cus");
    const s = await cus.startSession({ project: `beta-${t}`, agent: "core/picky" });
    const turn = await cus.sendMessage(s.id, { content: "hello" });
    expect(turn).toMatchObject({ status: "completed", model: "scripted/fast-v2" });
    expect(lastModel()).toBe("fast-v2");
    // ann holds every model right: `smart`.
    const ann = await as("ann");
    const s2 = await ann.startSession({ project: `beta-${t}`, agent: "core/picky" });
    expect(await ann.sendMessage(s2.id, { content: "hello" })).toMatchObject({
      model: "scripted/smart-v1",
    });
  });

  it("falls back to the project's, then the workspace's, then the deployment's default", async () => {
    const ann = await as("ann");
    const inAlpha = await ann.startSession({ project: `alpha-${t}`, agent: "core/plain" });
    expect(await ann.sendMessage(inAlpha.id, { content: "hello" })).toMatchObject({
      model: "scripted/fast-v3",
    });
    const inBeta = await ann.startSession({ project: `beta-${t}`, agent: "core/plain" });
    expect(await ann.sendMessage(inBeta.id, { content: "hello" })).toMatchObject({
      model: "scripted/fast-v2",
    });
    const other = await as("ann", "other");
    const inGamma = await other.startSession({ project: `gamma-${t}`, agent: "core/plain" });
    expect(await other.sendMessage(inGamma.id, { content: "hello" })).toMatchObject({
      model: "scripted/default",
    });
  });

  it("lets the most specific level pick the model an alias names", async () => {
    const ann = await as("ann");
    for (const [project, served] of [
      [`alpha-${t}`, "scripted/fast-v3"],
      [`beta-${t}`, "scripted/fast-v2"],
    ]) {
      const s = await ann.startSession({ project: String(project), model: "fast" });
      expect(await ann.sendMessage(s.id, { content: "hello" })).toMatchObject({ model: served });
    }
    const other = await as("ann", "other");
    const s = await other.startSession({ project: `gamma-${t}`, model: "fast" });
    expect(await other.sendMessage(s.id, { content: "hello" })).toMatchObject({
      model: "scripted/fast-v1",
    });
  });

  it("narrows: a level's allow list takes broader models away", async () => {
    const ann = await as("ann");
    await expect(
      ann.startSession({ project: `narrow-${t}`, model: "smart" }),
    ).rejects.toMatchObject({ status: 404 });
    const s = await ann.startSession({ project: `narrow-${t}`, model: "fast" });
    expect(await ann.sendMessage(s.id, { content: "hello" })).toMatchObject({
      model: "scripted/fast-v2",
    });
    const { models } = await ann.listModels({ project: `narrow-${t}` });
    expect(models.map((m) => m.id).sort()).toEqual(["scripted/default", "scripted/fast-v2"]);
  });

  it("lets the user override the session's model only within their rights", async () => {
    const cus = await as("cus");
    // Not configured anywhere: refused, naming it.
    await expect(
      cus.startSession({ project: `beta-${t}`, model: "nowhere/none" }),
    ).rejects.toMatchObject({ status: 404, message: expect.stringContaining("nowhere/none") });
    // Configured, but not the user's.
    await expect(cus.startSession({ project: `beta-${t}`, model: "smart" })).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("smart"),
    });
    await expect(
      cus.startSession({ project: `beta-${t}`, model: "scripted/smart-v1" }),
    ).rejects.toMatchObject({ status: 403 });
    const s = await cus.startSession({ project: `beta-${t}`, model: "default" });
    expect(await cus.sendMessage(s.id, { content: "hello" })).toMatchObject({
      model: "scripted/default",
    });
  });

  it("refuses to start a session no model fits, naming what was asked for", async () => {
    const ann = await as("ann");
    await expect(
      ann.startSession({ project: `closed-${t}`, agent: "core/picky" }),
    ).rejects.toMatchObject({
      status: 404,
      message: expect.stringMatching(/nowhere\/none.*smart.*fast.*default/s),
    });
  });

  it("pins the session's model at start: a later configuration reaches only new sessions", async () => {
    const ann = await as("ann");
    const project = `pinned-${t}`;
    const before = await ann.startSession({ project, agent: "core/plain" });
    await seed(deployment, ADMIN_KEY, {
      [`/${project}/.system/models`]: JSON.stringify({ default: "scripted/fast-v1" }),
    });
    expect(await ann.sendMessage(before.id, { content: "hello" })).toMatchObject({
      model: "scripted/default",
    });
    const after = await ann.startSession({ project, agent: "core/plain" });
    expect(await ann.sendMessage(after.id, { content: "hello" })).toMatchObject({
      model: "scripted/fast-v1",
    });
    await seed(deployment, ADMIN_KEY, {
      [`/${project}/.system/models`]: JSON.stringify({ default: "scripted/default" }),
    });
  });

  it("runs a turn on the model its message asks for when the user may, and says when not", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project: `beta-${t}`, agent: "core/plain" });
    const asked = await ann.sendMessage(s.id, { content: "hello", model: "smart" });
    expect(asked).toMatchObject({ status: "completed", model: "scripted/smart-v1" });
    expect(asked.model_substitution).toBeUndefined();
    expect(lastModel()).toBe("smart-v1");
    // The next turn is back on the session's model.
    expect(await ann.sendMessage(s.id, { content: "hello" })).toMatchObject({
      model: "scripted/fast-v2",
    });
    const cus = await as("cus");
    const s2 = await cus.startSession({ project: `beta-${t}`, agent: "core/plain" });
    const refused = await cus.sendMessage(s2.id, { content: "hello", model: "smart" });
    expect(refused).toMatchObject({
      status: "completed",
      model: "scripted/fast-v2",
      model_substitution: {
        requested: "smart",
        used: "scripted/fast-v2",
        reason: expect.stringMatching(/right/),
      },
    });
    const unknown = await cus.sendMessage(s2.id, { content: "hello", model: "gpt-unheard-of" });
    expect(unknown.model_substitution).toMatchObject({
      requested: "gpt-unheard-of",
      reason: expect.stringMatching(/configured/),
    });
  });

  it("falls back to the agent's next model on overload, rate-limit and unavailable errors, recording it", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project: `beta-${t}`, agent: "core/fallback" });
    for (const [status, reason] of [
      [529, "overloaded"],
      [429, "rate_limited"],
      [503, "unavailable"],
    ] as const) {
      model.fail("big", status);
      try {
        const turn = await ann.sendMessage(s.id, { content: "hello" });
        expect(turn.status).toBe("completed");
        const fallback = turn.items.find((i) => i.kind === "model_fallback");
        expect(fallback).toMatchObject({
          from: "scripted/big",
          to: "scripted/small",
          reason,
          usage: { model: "scripted/big", outcome: reason, charged: true },
        });
        expect(answerItem(turn)).toMatchObject({
          text: "OK",
          usage: { model: "scripted/small", outcome: "ok" },
        });
        expect(model.requests.slice(-2).map((r) => r.model)).toEqual(["big", "small"]);
      } finally {
        model.heal("big");
      }
    }
    // For that request only: the next one goes to big again.
    expect(await ann.sendMessage(s.id, { content: "hello" })).toMatchObject({
      model: "scripted/big",
    });
    expect(lastModel()).toBe("big");
  });

  it("records a fallback whose next model cannot be reached, and fails the turn", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project: `beta-${t}`, agent: "core/fallback-unbound" });
    model.fail("big", 529);
    try {
      const turn = await ann.sendMessage(s.id, { content: "hello" });
      expect(turn).toMatchObject({ status: "failed", error: expect.stringMatching(/EACCES/) });
      expect(turn.items.find((i) => i.kind === "model_fallback")).toMatchObject({
        from: "scripted/big",
        to: "unbound/unbound-v1",
        reason: "overloaded",
      });
    } finally {
      model.heal("big");
    }
  });

  it("fails the turn on any other model error, without falling back", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project: `beta-${t}`, agent: "core/fallback" });
    model.fail("big", 401);
    try {
      const before = model.requests.length;
      const turn = await ann.sendMessage(s.id, { content: "hello" });
      expect(turn).toMatchObject({ status: "failed", stop_reason: { type: "error" } });
      expect(turn.items.some((i) => i.kind === "model_fallback")).toBe(false);
      expect(model.requests.slice(before).map((r) => r.model)).toEqual(["big"]);
    } finally {
      model.heal("big");
    }
  });

  it("meters every request: tokens, cost, latency and outcome, on the turn's items and in the workspace's budget", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project: `beta-${t}`, model: "smart" });
    const turn = await ann.sendMessage(s.id, { content: "hello" });
    const usage = {
      model: "scripted/smart-v1",
      provider: "scripted",
      input_tokens: 8,
      output_tokens: 3,
      cached_tokens: 4,
      cost: 16,
      latency_ms: expect.any(Number),
      outcome: "ok",
      charged: true,
    };
    expect(answerItem(turn)?.usage).toEqual(usage);
    const records = await modelUsage(deployment, ADMIN_KEY);
    expect(records.filter((r) => r.session === s.id)).toEqual([
      {
        ...usage,
        session: s.id,
        turn: turn.id,
        user: u("ann"),
        project: `beta-${t}`,
      },
    ]);
  });

  it("injects the provider's key through the secrets gateway, and never shows it", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project: `beta-${t}`, model: "keyed/keyed-v1" });
    const turn = await ann.sendMessage(s.id, { content: "hello" });
    expect(turn.status).toBe("completed");
    expect(model.requests.at(-1)).toMatchObject({
      model: "keyed-v1",
      authorization: `Bearer ${DEPLOY_KEY}`,
    });
    // A provider without a key sends none.
    await ann.sendMessage((await ann.startSession({ project: `beta-${t}` })).id, {
      content: "hello",
    });
    expect(model.requests.at(-1)?.authorization).not.toContain(DEPLOY_KEY);
    // A secret bound to another plugin is never sent to a model: the turn fails.
    const unbound = await ann.startSession({ project: `beta-${t}`, model: "unbound/unbound-v1" });
    const before = model.requests.length;
    const failed = await ann.sendMessage(unbound.id, { content: "hello" });
    expect(failed).toMatchObject({ status: "failed", error: expect.stringMatching(/EACCES/) });
    expect(model.requests.length).toBe(before);
    const items = await ann.listItems(s.id);
    const events = await ann.readEvents(s.id);
    expect(JSON.stringify([turn, failed, items, events])).not.toContain(DEPLOY_KEY);
  });

  it("meters the user's own provider without charging the workspace", async () => {
    const ann = await as("ann");
    await ann.setSecret({
      level: "user",
      name: "MY_MODEL_KEY",
      value: USER_KEY,
      bindings: { plugins: ["model-gateway"], hosts: ["127.0.0.1"] },
    });
    const config = {
      providers: [
        { id: "mine", api: "openai-completions", baseUrl: model.url, secret: "MY_MODEL_KEY" },
      ],
      models: [{ id: "mine/own-v1", alias: "own" }],
    };
    expect(await ann.setModelConfig(config)).toEqual(config);
    expect(await ann.getModelConfig()).toEqual(config);
    const s = await ann.startSession({ project: `beta-${t}`, model: "own" });
    const turn = await ann.sendMessage(s.id, { content: "hello" });
    expect(turn).toMatchObject({ status: "completed", model: "mine/own-v1" });
    expect(model.requests.at(-1)).toMatchObject({
      model: "own-v1",
      authorization: `Bearer ${USER_KEY}`,
    });
    expect(answerItem(turn)?.usage).toMatchObject({
      model: "mine/own-v1",
      provider: "mine",
      outcome: "ok",
      charged: false,
    });
    const records = (await modelUsage(deployment, ADMIN_KEY)).filter((r) => r.session === s.id);
    expect(records).toEqual([expect.objectContaining({ model: "mine/own-v1", charged: false })]);
    // Another user sees none of it.
    const cus = await as("cus");
    await expect(cus.startSession({ project: `beta-${t}`, model: "own" })).rejects.toMatchObject({
      status: 404,
    });
    // The user's own provider never borrows a workspace's or the deployment's key, even one bound
    // to the gateway and that host: only the user's own secrets serve it.
    await ann.setModelConfig({
      providers: [
        { id: "borrow", api: "openai-completions", baseUrl: model.url, secret: "DEPLOY_MODEL_KEY" },
      ],
      models: [{ id: "borrow/borrowed-v1" }],
    });
    const borrowing = await ann.startSession({ project: `beta-${t}`, model: "borrow/borrowed-v1" });
    const asked = model.requests.length;
    expect(await ann.sendMessage(borrowing.id, { content: "hello" })).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/ENOENT|EACCES/),
    });
    expect(model.requests.length).toBe(asked);
    await ann.setModelConfig(config);
    // A malformed configuration is refused.
    await expect(
      ann.setModelConfig({ providers: [{ id: "x", api: "carrier-pigeon", baseUrl: "nope" }] }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses a user's own provider over http or at a private or loopback address", async () => {
    const ann = await as("ann");
    for (const baseUrl of [
      "http://models.example.com/v1",
      "https://10.1.2.3/v1",
      "https://169.254.169.254/latest",
      "https://localhost/v1",
      "https://[::1]/v1",
    ])
      await expect(
        ann.setModelConfig({
          providers: [{ id: "mine", api: "openai-completions", baseUrl }],
          models: [{ id: "mine/x" }],
        }),
      ).rejects.toMatchObject({ status: 400 });
    // The deployment's own providers may be anywhere it says (here: the local scripted model).
    await expect(
      ann.setModelConfig({
        providers: [
          { id: "mine", api: "openai-completions", baseUrl: "https://models.example.com/v1" },
        ],
      }),
    ).resolves.toBeDefined();
    await ann.setModelConfig({});
  });

  it("lists the project's models; ones discovered through /models stay off until a level lists them", async () => {
    model.listed.splice(0, model.listed.length, "default", "extra-v9");
    const cus = await as("cus");
    const { models } = await cus.listModels({ project: `beta-${t}` });
    expect(models).toContainEqual({
      id: "scripted/smart-v1",
      aliases: ["smart"],
      provider: "scripted",
      level: "deployment",
      enabled: true,
      allowed: false,
    });
    expect(models).toContainEqual(
      expect.objectContaining({ id: "scripted/fast-v2", aliases: ["fast"], allowed: true }),
    );
    expect(models.some((m) => m.id === "scripted/extra-v9")).toBe(false);
    const found = await cus.listModels({ project: `beta-${t}`, discover: true });
    expect(found.models).toContainEqual(
      expect.objectContaining({ id: "scripted/extra-v9", enabled: false, discovered: true }),
    );
    expect(found.models.filter((m) => m.id === "scripted/default")).toEqual([
      expect.objectContaining({ enabled: true }),
    ]);
    const ann = await as("ann");
    await expect(
      ann.startSession({ project: `beta-${t}`, model: "scripted/extra-v9" }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("a deployment without model configuration", () => {
  it("has no single deployment provider: no session starts", async () => {
    // The variables of the single deployment provider this ticket removes.
    const bare = await startDeployment(HOST, {
      DEV_LOGIN: "true",
      ADMIN_KEY,
      LLM_BASE_URL: model.url,
      LLM_MODEL: "default",
    });
    try {
      await seed(bare, ADMIN_KEY, {
        "/alpha/.system/access": JSON.stringify({ "ann-bare": "owner" }),
      });
      const client = restClient(bare, await login(bare, "ann-bare"));
      await expect(client.startSession({ project: "alpha" })).rejects.toMatchObject({
        status: 404,
        message: expect.stringMatching(/model/),
      });
    } finally {
      await bare.close();
    }
  }, 60_000);
});
