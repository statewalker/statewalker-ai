// The `local` model provider (statewalker/statewalker-root#143, decision #105): on CellB in a
// browser, a model runs in the page with no key, its weights downloaded only by the user's action
// and cached in the browser; its models are subject to `models.use`; where no local engine runs,
// the provider answers ENOSYS. Whether a deployment runs one is a capability of its runtime
// (`deployment.localModels`, the browser runner's): the page's engine here is a stand-in that
// answers through the scripted model once "downloaded". Over REST and RPC.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Deployment,
  type FakeModel,
  fakeModel,
  type Item,
  LOCAL_MODELS,
  login,
  modelUsage,
  restClient,
  rpcClient,
  type SessionClient,
  seed,
  startDeployment,
} from "../src/index.js";

const HOST = new URL("../../ai-host-do/", import.meta.url);
const ADMIN_KEY = "conformance-admin-key";

const AP = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const CATALOG = {
  "/core/plugin.json": JSON.stringify({ $schema: AP, name: "core", version: "1.0.0" }),
  "/core/dev.cellb.harness/agents/plain.md": "---\nname: plain\n---\nPLAIN\n",
  // A local model first, the deployment's scripted model next.
  ...Object.fromEntries(
    ["rest", "rpc"].map((t) => [
      `/core/dev.cellb.harness/agents/offline-${t}.md`,
      `---\nname: offline-${t}\nmodels: [local/tiny-${t}, scripted/default]\n---\nOFFLINE\n`,
    ]),
  ),
};

const TRANSPORTS = ["rest", "rpc"];
const FILES: Record<string, string> = Object.fromEntries(
  TRANSPORTS.flatMap((t) => [
    [`/home-${t}/.system/access`, JSON.stringify({ [`ann-${t}`]: "owner", [`cus-${t}`]: "plain" })],
    [
      `/home-${t}/.system/roles`,
      JSON.stringify({
        // The deployment's scripted model only: no right to the local models.
        plain: "files.read, files.list, agents.use:core/*, models.use:scripted/default",
      }),
    ],
  ]),
);

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
    CATALOG: JSON.stringify(CATALOG),
    DEFAULT_AGENT: "core/plain",
    MODELS: JSON.stringify({
      providers: [...config.providers, { id: "local", api: "local" }],
      models: [{ id: "scripted/default" }, ...TRANSPORTS.map((t) => ({ id: `local/tiny-${t}` }))],
      default: "scripted/default",
    }),
  });
  await seed(deployment, ADMIN_KEY, FILES);
}, 120_000);
afterAll(async () => {
  for (const s of sockets) s.close();
  await deployment?.close();
  await model?.close();
});

const answerItem = (items: Item[]): Item | undefined =>
  items.find((i) => i.kind === "message" && i.role === "assistant");

describe.each(transports)("the local model provider over %s", (name, connect) => {
  const t = name.toLowerCase();
  const tiny = `tiny-${t}`;
  const as = async (user: string) => connect(deployment, await login(deployment, `${user}-${t}`));

  it.runIf(LOCAL_MODELS)(
    "serves a local model in the page with no key, once the user downloaded its weights",
    async () => {
      const ann = await as("ann");
      // Not downloaded: the request never starts a download; the gateway falls back.
      const s = await ann.startSession({ project: `home-${t}`, agent: `core/offline-${t}` });
      const before = await ann.sendMessage(s.id, { content: "hello" });
      expect(before.status).toBe("completed");
      expect(answerItem(before.items)).toMatchObject({ usage: { model: "scripted/default" } });
      expect(before.items.find((i) => i.kind === "model_fallback")).toMatchObject({
        from: `local/${tiny}`,
        to: "scripted/default",
        reason: "unavailable",
      });
      expect(model.requests.some((r) => r.model === tiny)).toBe(false);

      // The user downloads the weights in the page.
      await deployment.localModels?.download(tiny, model.url);
      const turn = await ann.sendMessage(s.id, { content: "hello" });
      expect(turn).toMatchObject({ status: "completed", model: `local/${tiny}` });
      expect(answerItem(turn.items)).toMatchObject({
        text: "OK",
        usage: { model: `local/${tiny}`, provider: "local", outcome: "ok" },
      });
      // The engine got the request with no key.
      const asked = model.requests.at(-1);
      expect(asked).toMatchObject({ model: tiny });
      expect(asked?.authorization).toBeUndefined();
      // Metered like any request (the attempt that found no weights spent nothing).
      const records = await modelUsage(deployment, ADMIN_KEY);
      expect(
        records.filter((r) => r.session === s.id && r.model === `local/${tiny}`),
      ).toMatchObject([{ outcome: "ok", input_tokens: 8 }]);
    },
  );

  it("subjects local models to the model right", async () => {
    const cus = await as("cus");
    await expect(
      cus.startSession({ project: `home-${t}`, model: `local/${tiny}` }),
    ).rejects.toMatchObject({ status: 403, message: expect.stringContaining(`local/${tiny}`) });
    const { models: listed } = await cus.listModels({ project: `home-${t}` });
    expect(listed.find((m) => m.id === `local/${tiny}`)).toMatchObject({
      provider: "local",
      allowed: false,
    });
    // The agent that asks for it first runs on the next model the user may use.
    const s = await cus.startSession({ project: `home-${t}`, agent: `core/offline-${t}` });
    expect(await cus.sendMessage(s.id, { content: "hello" })).toMatchObject({
      status: "completed",
      model: "scripted/default",
    });
  });

  it.runIf(!LOCAL_MODELS)("answers ENOSYS where no local engine runs", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project: `home-${t}`, model: `local/${tiny}` });
    const before = model.requests.length;
    const turn = await ann.sendMessage(s.id, { content: "hello" });
    expect(turn).toMatchObject({ status: "failed", error: expect.stringMatching(/ENOSYS/) });
    expect(model.requests.length).toBe(before);
    // An agent that lists another model after it runs on that one.
    const offline = await ann.startSession({ project: `home-${t}`, agent: `core/offline-${t}` });
    const next = await ann.sendMessage(offline.id, { content: "hello" });
    expect(next.status).toBe("completed");
    expect(answerItem(next.items)).toMatchObject({ usage: { model: "scripted/default" } });
    expect(next.items.find((i) => i.kind === "model_fallback")).toMatchObject({
      from: `local/${tiny}`,
      to: "scripted/default",
      reason: "unavailable",
    });
  });
});
