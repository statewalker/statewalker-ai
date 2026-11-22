// Secrets (statewalker/statewalker-root#133, decision #104): keys for tools, MCP servers and models,
// kept by the harness at deployment, workspace, project and user level, write-only through the
// session API, and injected by the host-side gateway only into requests whose plugin and host a
// binding names. Run against the harness's own deployment (ai-host-do) on CellB Node in-process,
// with the scripted model and a fake REST server, over REST and RPC.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CAN,
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

// A browser page holds no deployment-held key (SECRETS_KEY, DEPLOYMENT_SECRETS): tests/browser.test.ts.

const HOST = new URL("../../ai-host-do/", import.meta.url);
const ADMIN_KEY = "conformance-admin-key";
const DEPLOY_VALUE = "deploy-value-7f3a9c";

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

const AP = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
/** GET operations, each sending a bearer key from the named secret (or none). */
const spec = (server: string, ops: Record<string, string | null>) => ({
  openapi: "3.1.0",
  info: { title: "fixture", version: "1" },
  servers: [{ url: server }],
  components: {
    securitySchemes: Object.fromEntries(
      [...new Set(Object.values(ops).filter((x): x is string => !!x))].map((secret) => [
        secret,
        { type: "http", scheme: "bearer", "x-dev.cellb.harness": { secret } },
      ]),
    ),
  },
  paths: Object.fromEntries(
    Object.entries(ops).map(([op, secret]) => [
      `/${op}`,
      {
        get: {
          operationId: op,
          security: secret ? [{ [secret]: [] }] : [],
          ...(op === "search"
            ? { parameters: [{ name: "q", in: "query", schema: { type: "string" } }] }
            : {}),
        },
      },
    ]),
  ),
});
const catalog = (base: string, other: string) => ({
  "/fixture/plugin.json": JSON.stringify({ $schema: AP, name: "fixture" }),
  "/fixture/dev.cellb.harness/agents/default.md":
    "---\nname: default\ntools: [fixture/*, other/*]\n---\n",
  "/fixture/dev.cellb.harness/tools/rest/api.json": JSON.stringify(
    spec(base, { call: "API_TOKEN", echo: "API_TOKEN", deploy: "DEPLOY_TOKEN", search: null }),
  ),
  "/fixture/dev.cellb.harness/tools/rest/away.json": JSON.stringify({
    ...spec(other, { elsewhere: "API_TOKEN" }),
    paths: { "/away": { get: { operationId: "elsewhere", security: [{ API_TOKEN: [] }] } } },
  }),
  "/other/plugin.json": JSON.stringify({ $schema: AP, name: "other" }),
  "/other/dev.cellb.harness/tools/rest/api.json": JSON.stringify({
    ...spec(base, { call: "API_TOKEN" }),
    paths: { "/other": { get: { operationId: "call", security: [{ API_TOKEN: [] }] } } },
  }),
});

beforeAll(async () => {
  model = await fakeModel();
  rest = await fakeRest();
  const other = `http://localhost:${rest.port}`;
  deployment = await startDeployment(HOST, {
    MODELS: model.deploymentModels(),
    DEV_LOGIN: "true",
    ADMIN_KEY,
    SECRETS_KEY: "conformance-secrets-key",
    DEPLOY_TOKEN: DEPLOY_VALUE,
    DEPLOYMENT_SECRETS: JSON.stringify({
      DEPLOY_TOKEN: { plugins: ["fixture"], hosts: ["127.0.0.1"] },
    }),
    // The REST tools of two plugins, imported from OpenAPI specs (#129); the key's placeholder is
    // the route's, never the model's.
    CATALOG: JSON.stringify(catalog(rest.url, other)),
    DEFAULT_AGENT: "fixture/default",
  });
  await seed(deployment, ADMIN_KEY, {
    "/.system/access": perTransport({ wendy: "admin" }),
    "/alpha/readme.md": "# alpha\n",
    "/alpha/.system/access": perTransport({ ann: "owner", bob: "editor" }),
    "/beta/.system/access": perTransport({ ann: "owner", bob: "owner", cara: "keymaster" }),
    "/beta/.system/roles": JSON.stringify({ keymaster: "files.read, secrets.write:workspace" }),
  });
}, 120_000);
afterAll(async () => {
  for (const s of sockets) s.close();
  await deployment?.close();
  await model?.close();
  await rest?.close();
});

describe.each(transports)("secrets over %s", (name, connect) => {
  const u = (user: string) => `${user}-${name.toLowerCase()}`;
  const as = async (user: string) => connect(deployment, await login(deployment, u(user)));
  const binding = { plugins: ["fixture"], hosts: ["127.0.0.1"] };

  it.runIf(CAN.deploymentSecrets)(
    "lists a secret's name, level, bindings and update time, never its value",
    async () => {
      const ann = await as("ann");
      const before = Date.now();
      const set = await ann.setSecret({
        level: "user",
        name: "API_TOKEN",
        value: "user-value-41d2",
        bindings: binding,
      });
      expect(set).toEqual({
        name: "API_TOKEN",
        level: "user",
        bindings: binding,
        updated: expect.any(Number),
      });
      expect(set.updated).toBeGreaterThanOrEqual(before);
      await ann.setSecret({
        level: "project",
        project: "alpha",
        name: "PROJECT_KEY",
        value: "project-value-88aa",
        bindings: binding,
      });
      const users = await ann.listSecrets({ level: "user" });
      const projects = await ann.listSecrets({ level: "project", project: "alpha" });
      expect(users.secrets).toEqual([set]);
      expect(projects.secrets).toEqual([
        expect.objectContaining({ name: "PROJECT_KEY", level: "project", project: "alpha" }),
      ]);
      expect(JSON.stringify([set, users, projects])).not.toMatch(/value-|"value"/);
    },
  );

  it.runIf(CAN.deploymentSecrets)(
    "manages secrets only at a level the caller holds secrets.write for",
    async () => {
      const secret = (
        level: "user" | "project" | "workspace" | "deployment",
        project?: string,
      ) => ({
        level,
        project,
        name: "SCOPED",
        value: "scoped-value-19ce",
        bindings: binding,
      });
      const ann = await as("ann");
      const bob = await as("bob");
      const wendy = await as("wendy");
      // Project secrets: the project's owner only (bob is an editor of alpha, an owner of beta).
      await expect(bob.setSecret(secret("project", "alpha"))).rejects.toMatchObject({
        status: 403,
      });
      await expect(bob.listSecrets({ level: "project", project: "alpha" })).rejects.toMatchObject({
        status: 403,
      });
      await expect(bob.setSecret(secret("project", "beta"))).resolves.toMatchObject({
        project: "beta",
      });
      await expect(
        ann.deleteSecret({ level: "project", project: "beta", name: "SCOPED" }),
      ).resolves.toEqual({
        deleted: true,
      });
      // Workspace secrets: the workspace admin only.
      await expect(ann.setSecret(secret("workspace"))).rejects.toMatchObject({ status: 403 });
      // A project's custom role cannot grant a workspace-level permission.
      const cara = await as("cara");
      await expect(cara.setSecret(secret("workspace"))).rejects.toMatchObject({ status: 403 });
      await expect(ann.listSecrets({ level: "workspace" })).rejects.toMatchObject({ status: 403 });
      await expect(wendy.setSecret(secret("workspace"))).resolves.toMatchObject({
        level: "workspace",
      });
      await expect(wendy.listSecrets({ level: "workspace" })).resolves.toMatchObject({
        secrets: [expect.objectContaining({ name: "SCOPED" })],
      });
      await wendy.deleteSecret({ level: "workspace", name: "SCOPED" });
      // Deployment secrets are the runtime's: listed to the admin, written by nobody.
      await expect(wendy.setSecret(secret("deployment"))).rejects.toMatchObject({ status: 403 });
      await expect(wendy.listSecrets({ level: "deployment" })).resolves.toEqual({
        secrets: [{ name: "DEPLOY_TOKEN", level: "deployment", bindings: binding, updated: 0 }],
      });
      await expect(ann.listSecrets({ level: "deployment" })).rejects.toMatchObject({ status: 403 });
      // User secrets: each user their own, and no one else's.
      await bob.setSecret(secret("user"));
      expect((await ann.listSecrets({ level: "user" })).secrets.map((s) => s.name)).not.toContain(
        "SCOPED",
      );
      await expect(ann.deleteSecret({ level: "user", name: "SCOPED" })).rejects.toMatchObject({
        status: 404,
      });
      await bob.deleteSecret({ level: "user", name: "SCOPED" });
    },
  );

  it("refuses a malformed secret or binding", async () => {
    const ann = await as("ann");
    for (const bad of [
      { name: "1BAD", bindings: binding },
      { name: "OK", bindings: { plugins: [], hosts: ["127.0.0.1"] } },
      { name: "OK", bindings: { plugins: ["fixture"], hosts: ["http://127.0.0.1/"] } },
      { name: "OK", bindings: { plugins: ["fixture"] } },
    ])
      await expect(
        ann.setSecret({ level: "user", value: "v", ...bad } as never),
      ).rejects.toMatchObject({ status: 400 });
  });

  // A session in alpha, and the requests the fake REST server received during `run`.
  const received = async (run: () => Promise<unknown>) => {
    const from = rest.requests.length;
    await run();
    return rest.requests.slice(from);
  };
  const toolResults = (turn: { items: { kind: string }[] }) =>
    turn.items.filter((i) => i.kind === "tool_result") as {
      output?: string;
      isError?: boolean;
      secrets?: string[];
    }[];

  it("injects a bound secret into a tool's outgoing request, and the item names it", async () => {
    const ann = await as("ann");
    await ann.setSecret({
      level: "user",
      name: "API_TOKEN",
      value: "inject-me-5b7e",
      bindings: binding,
    });
    const session = await ann.startSession({ project: "alpha" });
    let turn!: Awaited<ReturnType<SessionClient["sendMessage"]>>;
    const got = await received(async () => {
      turn = await ann.sendMessage(session.id, { content: "CALL fixture__call {}" });
    });
    expect(got).toEqual([
      expect.objectContaining({
        url: "/call",
        headers: expect.objectContaining({ authorization: "Bearer inject-me-5b7e" }),
      }),
    ]);
    expect(toolResults(turn)).toEqual([
      expect.objectContaining({ isError: false, secrets: ["API_TOKEN"] }),
    ]);
    // The value is in no item, and not in what the model was sent.
    const { items } = await ann.listItems(session.id);
    expect(JSON.stringify(items)).not.toContain("inject-me-5b7e");
    expect(JSON.stringify(model.requests)).not.toContain("inject-me-5b7e");
  });

  const authOf = (got: { headers: Record<string, string> }[]) =>
    got.map((r) => r.headers.authorization);

  it.runIf(CAN.deploymentSecrets)(
    "the most specific level wins: user, then project, then workspace",
    async () => {
      const ann = await as("ann");
      const wendy = await as("wendy");
      const session = await ann.startSession({ project: "alpha" });
      const call = () => ann.sendMessage(session.id, { content: "CALL fixture__call {}" });
      await wendy.setSecret({
        level: "workspace",
        name: "API_TOKEN",
        value: "ws-level-value",
        bindings: binding,
      });
      await ann.setSecret({
        level: "project",
        project: "alpha",
        name: "API_TOKEN",
        value: "project-level-value",
        bindings: binding,
      });
      await ann.setSecret({
        level: "user",
        name: "API_TOKEN",
        value: "user-level-value",
        bindings: binding,
      });
      expect(authOf(await received(call))).toEqual(["Bearer user-level-value"]);
      await ann.deleteSecret({ level: "user", name: "API_TOKEN" });
      expect(authOf(await received(call))).toEqual(["Bearer project-level-value"]);
      await ann.deleteSecret({ level: "project", project: "alpha", name: "API_TOKEN" });
      expect(authOf(await received(call))).toEqual(["Bearer ws-level-value"]);
      await wendy.deleteSecret({ level: "workspace", name: "API_TOKEN" });
    },
  );

  it.runIf(CAN.deploymentSecrets)(
    "a project plugin cannot send a shared secret to an unbound host or use one not bound to it",
    async () => {
      const ann = await as("ann");
      const wendy = await as("wendy");
      await ann.deleteSecret({ level: "user", name: "API_TOKEN" }).catch(() => {});
      await wendy.setSecret({
        level: "workspace",
        name: "API_TOKEN",
        value: "shared-key-c0ffee",
        bindings: binding,
      });
      try {
        const session = await ann.startSession({ project: "alpha" });
        for (const tool of ["fixture__elsewhere", "other__call"]) {
          let turn!: Awaited<ReturnType<SessionClient["sendMessage"]>>;
          const got = await received(async () => {
            turn = await ann.sendMessage(session.id, { content: `CALL ${tool} {}` });
          });
          expect(got).toEqual([]);
          expect(toolResults(turn)).toEqual([
            expect.objectContaining({
              isError: true,
              secrets: ["API_TOKEN"],
              output: expect.stringMatching(/secret API_TOKEN is not bound/),
            }),
          ]);
        }
        // The model cannot name a secret through its input either: it reaches the host encoded.
        const got = await received(() =>
          ann.sendMessage(session.id, {
            content: `CALL fixture__search ${JSON.stringify({ q: "{{secret:API_TOKEN}}" })}`,
          }),
        );
        expect(got.map((r) => decodeURIComponent(r.url))).toEqual([
          "/search?q={{secret:API_TOKEN}}",
        ]);
        const { items } = await ann.listItems(session.id);
        expect(JSON.stringify([items, rest.requests])).not.toContain("shared-key-c0ffee");
      } finally {
        await wendy.deleteSecret({ level: "workspace", name: "API_TOKEN" });
      }
    },
  );

  it("a replaced secret applies to the next call; a deleted one fails the call by name", async () => {
    const ann = await as("ann");
    const session = await ann.startSession({ project: "alpha" });
    const call = () => ann.sendMessage(session.id, { content: "CALL fixture__call {}" });
    await ann.setSecret({
      level: "user",
      name: "API_TOKEN",
      value: "first-value-0001",
      bindings: binding,
    });
    expect(authOf(await received(call))).toEqual(["Bearer first-value-0001"]);
    await ann.setSecret({
      level: "user",
      name: "API_TOKEN",
      value: "second-value-0002",
      bindings: binding,
    });
    expect(authOf(await received(call))).toEqual(["Bearer second-value-0002"]);
    await ann.deleteSecret({ level: "user", name: "API_TOKEN" });
    let turn!: Awaited<ReturnType<SessionClient["sendMessage"]>>;
    expect(
      await received(async () => {
        turn = await call();
      }),
    ).toEqual([]);
    expect(toolResults(turn)).toEqual([
      expect.objectContaining({
        isError: true,
        secrets: ["API_TOKEN"],
        output: expect.stringContaining("secret API_TOKEN is not set"),
      }),
    ]);
  });

  it("never shows a secret's value in items or error text, even when a service echoes it", async () => {
    const ann = await as("ann");
    await ann.setSecret({
      level: "user",
      name: "API_TOKEN",
      value: "echoed-value-ab12",
      bindings: binding,
    });
    const session = await ann.startSession({ project: "alpha" });
    const turn = await ann.sendMessage(session.id, { content: "CALL fixture__echo {}" });
    expect(toolResults(turn)).toEqual([
      expect.objectContaining({
        isError: false,
        output: expect.stringContaining("Bearer [secret API_TOKEN]"),
      }),
    ]);
    const { items } = await ann.listItems(session.id);
    expect(JSON.stringify([items, model.requests])).not.toContain("echoed-value-ab12");
  });

  it.runIf(CAN.deploymentSecrets)(
    "a deployment secret reaches only its bound plugin and host",
    async () => {
      const ann = await as("ann");
      const session = await ann.startSession({ project: "alpha" });
      const got = await received(() =>
        ann.sendMessage(session.id, { content: "CALL fixture__deploy {}" }),
      );
      expect(authOf(got)).toEqual([`Bearer ${DEPLOY_VALUE}`]);
      const { items } = await ann.listItems(session.id);
      expect(items.find((i) => i.kind === "tool_result")?.secrets).toEqual(["DEPLOY_TOKEN"]);
      expect(JSON.stringify(items)).not.toContain(DEPLOY_VALUE);
    },
  );

  it("erasing a user erases their own secrets", async () => {
    const dora = await as("dora");
    await dora.setSecret({
      level: "user",
      name: "MINE",
      value: "dora-value-77",
      bindings: binding,
    });
    await dora.eraseUser();
    expect(await dora.listSecrets({ level: "user" })).toEqual({ secrets: [] });
  });
});
