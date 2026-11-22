// CellB in a browser (statewalker/statewalker-root#132): a browser deployment is one person's page,
// so it holds no key of the deployment's: SECRETS_KEY and DEPLOYMENT_SECRETS (with the values it
// names) are kept off it, and only the signed-in user's own secrets are kept, sealed in the page's
// own storage. Run on every runtime: in Chromium the runner builds the deployment as a page would
// (no deployment-held secrets reach it); on Node the deployment is given them anyway, with
// HOSTING "browser", and must not use them.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Deployment,
  type FakeModel,
  type FakeRest,
  fakeModel,
  fakeRest,
  login,
  restClient,
  rpcClient,
  type SessionClient,
  seed,
  startDeployment,
} from "../src/index.js";

const HOST = new URL("../../ai-host-do/", import.meta.url);
const ADMIN_KEY = "conformance-admin-key";
const DEPLOY_VALUE = "deploy-value-browser-31c7";

const AP = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const api = (server: string) => ({
  openapi: "3.1.0",
  info: { title: "fixture", version: "1" },
  servers: [{ url: server }],
  components: {
    securitySchemes: {
      API_TOKEN: { type: "http", scheme: "bearer", "x-dev.cellb.harness": { secret: "API_TOKEN" } },
      DEPLOY_TOKEN: {
        type: "http",
        scheme: "bearer",
        "x-dev.cellb.harness": { secret: "DEPLOY_TOKEN" },
      },
    },
  },
  paths: {
    "/call": { get: { operationId: "call", security: [{ API_TOKEN: [] }] } },
    "/deploy": { get: { operationId: "deploy", security: [{ DEPLOY_TOKEN: [] }] } },
  },
});

const TRANSPORTS = ["rest", "rpc"];
const perTransport = (roles: Record<string, string>) =>
  JSON.stringify(
    Object.fromEntries(
      TRANSPORTS.flatMap((t) =>
        Object.entries(roles).map(([user, role]) => [`${user}-${t}`, role]),
      ),
    ),
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
let rest: FakeRest;
let deployment: Deployment;

beforeAll(async () => {
  model = await fakeModel();
  rest = await fakeRest();
  deployment = await startDeployment(HOST, {
    HOSTING: "browser",
    MODELS: model.deploymentModels(),
    DEV_LOGIN: "true",
    ADMIN_KEY,
    // What a server deployment would be given; a browser deployment must hold none of it.
    SECRETS_KEY: "conformance-secrets-key",
    DEPLOY_TOKEN: DEPLOY_VALUE,
    DEPLOYMENT_SECRETS: JSON.stringify({
      DEPLOY_TOKEN: { plugins: ["fixture"], hosts: ["127.0.0.1"] },
    }),
    CATALOG: JSON.stringify({
      "/fixture/plugin.json": JSON.stringify({ $schema: AP, name: "fixture" }),
      "/fixture/dev.cellb.harness/agents/default.md":
        "---\nname: default\ntools: [fixture/*]\n---\n",
      "/fixture/dev.cellb.harness/tools/rest/api.json": JSON.stringify(api(rest.url)),
    }),
    DEFAULT_AGENT: "fixture/default",
  });
  await seed(deployment, ADMIN_KEY, {
    "/.system/access": perTransport({ wendy: "admin" }),
    "/alpha/.system/access": perTransport({ ann: "owner", bob: "editor" }),
  });
}, 120_000);
afterAll(async () => {
  for (const s of sockets) s.close();
  await deployment?.close();
  await model?.close();
  await rest?.close();
});

describe.each(transports)("a browser deployment's secrets over %s", (name, connect) => {
  const u = (user: string) => `${user}-${name.toLowerCase()}`;
  const as = async (user: string) => connect(deployment, await login(deployment, u(user)));
  const binding = { plugins: ["fixture"], hosts: ["127.0.0.1"] };
  const received = async (run: () => Promise<unknown>) => {
    const from = rest.requests.length;
    await run();
    return rest.requests.slice(from);
  };
  const toolResults = (turn: { items: { kind: string }[] }) =>
    turn.items.filter((i) => i.kind === "tool_result") as { output?: string; isError?: boolean }[];

  it("a browser page holds only the signed-in user's own secrets, and uses them", async () => {
    const ann = await as("ann");
    const bob = await as("bob");
    await ann.setSecret({
      level: "user",
      name: "API_TOKEN",
      value: "ann-own-5e1d",
      bindings: binding,
    });
    const session = await ann.startSession({ project: "alpha" });
    const got = await received(() =>
      ann.sendMessage(session.id, { content: "CALL fixture__call {}" }),
    );
    expect(got.map((r) => r.headers.authorization)).toEqual(["Bearer ann-own-5e1d"]);
    expect((await bob.listSecrets({ level: "user" })).secrets).toEqual([]);
    await ann.deleteSecret({ level: "user", name: "API_TOKEN" });
  });

  it("a browser deployment keeps no project or workspace secret, even for its owner or admin", async () => {
    const ann = await as("ann");
    const wendy = await as("wendy");
    const secret = { name: "SHARED", value: "shared-value-77ab", bindings: binding };
    await expect(
      ann.setSecret({ ...secret, level: "project", project: "alpha" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(wendy.setSecret({ ...secret, level: "workspace" })).rejects.toMatchObject({
      status: 403,
    });
    await expect(wendy.listSecrets({ level: "workspace" })).resolves.toEqual({ secrets: [] });
  });

  it("SECRETS_KEY and DEPLOYMENT_SECRETS never reach a browser deployment: no deployment secret is listed or sent", async () => {
    const ann = await as("ann");
    const wendy = await as("wendy");
    await expect(wendy.listSecrets({ level: "deployment" })).resolves.toEqual({ secrets: [] });
    const session = await ann.startSession({ project: "alpha" });
    let turn!: Awaited<ReturnType<SessionClient["sendMessage"]>>;
    const got = await received(async () => {
      turn = await ann.sendMessage(session.id, { content: "CALL fixture__deploy {}" });
    });
    expect(got).toEqual([]);
    expect(toolResults(turn)).toEqual([
      expect.objectContaining({
        isError: true,
        output: expect.stringContaining("secret DEPLOY_TOKEN is not set"),
      }),
    ]);
    const { items } = await ann.listItems(session.id);
    expect(JSON.stringify([items, model.requests])).not.toContain(DEPLOY_VALUE);
  });
});
