// Tool definitions and the session MCP endpoint (statewalker/statewalker-root#129, decided in #90):
// every tool is one OpenAPI document in the restricted profile, from a plugin's `tools/openapi`
// file or an imported REST spec, shown in `<project>/.agents/tools/`. An agent session's model is
// offered, and its own MCP endpoint (`/v1/sessions/{id}/mcp`) lists, exactly the same set: what its
// agent requests, its user's role grants and the mode does not deny. Asking tools ask per call; a
// forged call to an unoffered tool is refused; a REST call is rebuilt from its route, with the
// deployment's key added by the harness and never shown. Read tools run in parallel, others one at
// a time. Against the harness's own deployment on CellB Node in-process, with the scripted model
// and a fake REST server, over REST and RPC.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Deployment,
  type FakeModel,
  type FakeRest,
  fakeModel,
  fakeRest,
  login,
  type McpResponse,
  RUNTIME,
  restClient,
  rpcClient,
  type SessionClient,
  seed,
  startDeployment,
  type Turn,
} from "../src/index.js";

// A browser page holds no deployment-held key (SECRETS_KEY, DEPLOYMENT_SECRETS): tests/browser.test.ts.

const HOST = new URL("../../ai-host-do/", import.meta.url);
const ADMIN_KEY = "conformance-admin-key";
const AP = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const KEY = "weather-deploy-key-93c1";
/** Flue's own tools over the session's sandbox (the file view), not tool definitions. */
const SANDBOX = ["read", "write", "edit", "bash", "grep", "glob"];

/** The weather plugin's imported REST spec, served by the fake REST server. */
const weatherSpec = (base: string) => ({
  openapi: "3.0.3",
  info: { title: "Weather", version: "2" },
  servers: [{ url: `${base}/v2` }],
  components: {
    securitySchemes: {
      key: {
        type: "apiKey",
        in: "header",
        name: "X-Api-Key",
        "x-dev.cellb.harness": { secret: "WEATHER_KEY" },
      },
    },
  },
  security: [{ key: [] }],
  paths: {
    "/cities/{city}/forecast": {
      get: {
        operationId: "getForecast",
        summary: "The forecast for a city",
        parameters: [
          { name: "city", in: "path", required: true, schema: { type: "string" } },
          { name: "days", in: "query", schema: { type: "integer" } },
          { name: "X-Units", in: "header", schema: { type: "string" } },
        ],
        responses: { 200: { description: "ok" }, 404: { description: "no such city" } },
      },
    },
    "/reports": {
      post: {
        operationId: "addReport",
        summary: "Files a weather report",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { city: { type: "string" }, text: { type: "string" } },
                required: ["city", "text"],
              },
            },
          },
        },
        responses: { 201: { description: "filed" } },
      },
    },
  },
});

const catalog = (base: string) => ({
  "/weather/plugin.json": JSON.stringify({ $schema: AP, name: "weather", version: "1.0.0" }),
  "/weather/dev.cellb.harness/tools/rest/weather.json": JSON.stringify(weatherSpec(base)),
  "/weather/dev.cellb.harness/agents/forecaster.md":
    "---\nname: forecaster\ntools: [weather/*, notes/*]\n---\nFORECASTER\n",
  "/weather/dev.cellb.harness/agents/narrow.md":
    "---\nname: narrow\ntools: [weather/get_forecast]\n---\nNARROW\n",
  "/notes/plugin.json": JSON.stringify({ $schema: AP, name: "notes", version: "1.0.0" }),
  "/notes/dev.cellb.harness/tools/openapi.json": JSON.stringify({
    openapi: "3.1.0",
    info: { title: "notes", version: "1" },
    paths: {
      "/word-count": {
        post: {
          operationId: "word_count",
          summary: "Counts words",
          "x-dev.cellb.harness": { action: "read" },
          requestBody: {
            content: {
              "application/json": {
                schema: { type: "object", properties: { text: { type: "string" } } },
              },
            },
          },
        },
      },
    },
  }),
  "/notes/dev.cellb.harness/tools/word_count.js":
    "export default async (input) => String(input.text ?? '').split(/\\s+/).filter(Boolean).length;",
});

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

const USERS = {
  ann: "owner",
  ed: "editor",
  rita: "reader",
  don: "owner",
  mo: "owner",
  pat: "owner",
};

let model: FakeModel;
let rest: FakeRest;
let deployment: Deployment;

beforeAll(async () => {
  model = await fakeModel();
  rest = await fakeRest();
  deployment = await startDeployment(HOST, {
    MODELS: model.deploymentModels(),
    DEV_LOGIN: "true",
    ADMIN_KEY,
    CATALOG: JSON.stringify(catalog(rest.url)),
    DEFAULT_AGENT: "weather/forecaster",
    SECRETS_KEY: "conformance-secrets-key",
    WEATHER_KEY: KEY,
    DEPLOYMENT_SECRETS: JSON.stringify({
      WEATHER_KEY: { plugins: ["weather"], hosts: ["127.0.0.1"] },
    }),
  });
  const files: Record<string, string> = {};
  for (const t of ["rest", "rpc"])
    files[`/alpha-${t}/.system/access`] = JSON.stringify(
      Object.fromEntries(Object.entries(USERS).map(([u, r]) => [`${u}-${t}`, r])),
    );
  await seed(deployment, ADMIN_KEY, files);
}, 120_000);
afterAll(async () => {
  for (const s of sockets) s.close();
  await deployment?.close();
  await model?.close();
  await rest?.close();
});

const call = (tool: string, args: unknown) => `CALL ${tool} ${JSON.stringify(args)}`;
const toolResults = (turn: Turn) => turn.items.filter((i) => i.kind === "tool_result");

describe.each(transports)("tools over %s", (name, connect) => {
  const t = name.toLowerCase();
  const alpha = `alpha-${t}`;
  const as = async (user: string) => connect(deployment, await login(deployment, `${user}-${t}`));
  let rpcId = 0;
  const mcp = (client: SessionClient, session: string, method: string, params?: unknown) =>
    client.mcp(session, {
      jsonrpc: "2.0",
      id: ++rpcId,
      method,
      ...(params !== undefined ? { params } : {}),
    }) as Promise<McpResponse>;
  const listed = async (client: SessionClient, session: string) => {
    const res = await mcp(client, session, "tools/list");
    return (res.result as { tools: { name: string; inputSchema: Record<string, unknown> }[] })
      .tools;
  };
  /** The tools the model was offered in its last request, minus the sandbox's own. */
  const offered = (marker: string) => {
    const req = [...model.requests].reverse().find((r) => r.lastUserText === marker);
    if (!req) throw new Error(`the model never saw '${marker}'`);
    return req.tools.filter((n) => !SANDBOX.includes(n)).sort();
  };
  /** Asks the model once (it answers OK) and returns what it was offered. */
  const ask = async (client: SessionClient, session: string) => {
    const marker = `which tools ${++rpcId}`;
    await client.sendMessage(session, { content: marker });
    return offered(marker);
  };
  const names = async (client: SessionClient, session: string) =>
    (await listed(client, session)).map((x) => x.name).sort();

  it("offers the model, and lists over MCP, exactly the same narrowed set", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project: alpha });
    const tools = await listed(ann, s.id);
    const mine = tools.map((x) => x.name).sort();
    expect(mine).toEqual(
      expect.arrayContaining(["notes__word_count", "weather__add_report", "weather__get_forecast"]),
    );
    expect(await ask(ann, s.id)).toEqual(mine);
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    }
    // A reader is offered only read tools; the request of an agent never widens the role's grant.
    const rita = await as("rita");
    const r = await rita.startSession({ project: alpha });
    const readerSet = await names(rita, r.id);
    expect(readerSet).toEqual(
      expect.arrayContaining(["notes__word_count", "weather__get_forecast"]),
    );
    expect(readerSet).not.toContain("weather__add_report");
    expect(await ask(rita, r.id)).toEqual(readerSet);
    // An agent asking for less gets less, whatever the role.
    const n = await ann.startSession({ project: alpha, agent: "weather/narrow" });
    const narrow = await names(ann, n.id);
    expect(narrow.filter((x) => x.includes("__"))).toEqual(["weather__get_forecast"]);
    expect(await ask(ann, n.id)).toEqual(narrow);
  });

  it("does not offer tools the mode denies, and offers asking ones", async () => {
    const don = await as("don");
    const s = await don.startSession({ project: alpha });
    expect(await names(don, s.id)).toContain("weather__add_report");
    await don.setMode({ mode: "dontAsk" });
    try {
      const set = await names(don, s.id);
      expect(set).not.toContain("weather__add_report");
      expect(set).toContain("weather__get_forecast");
      expect(await ask(don, s.id)).toEqual(set);
    } finally {
      await don.setMode({ mode: "default" });
    }
  });

  it("shows each tool the role allows as its restricted-profile document in .agents/tools/", async () => {
    const rita = await as("rita");
    const s = await rita.startSession({ project: alpha });
    const ls = toolResults(
      await rita.sendMessage(s.id, {
        content: call("bash", { command: `ls /${alpha}/.agents/tools` }),
      }),
    )[0];
    expect(String(ls?.output).split(/\s+/).filter(Boolean).sort()).toEqual([
      "notes__word_count.openapi.json",
      "weather__get_forecast.openapi.json",
    ]);
    const read = toolResults(
      await rita.sendMessage(s.id, {
        content: call("read", {
          path: `/${alpha}/.agents/tools/weather__get_forecast.openapi.json`,
        }),
      }),
    )[0];
    const doc = JSON.parse(String(read?.output).replace(/^[^{]*/, ""));
    expect(Object.keys(doc.paths)).toEqual(["/tools/weather/get_forecast"]);
    expect(doc["x-dev.cellb.harness"]).toMatchObject({
      id: "weather/get_forecast",
      source: "rest",
      action: "read",
      route: { kind: "rest", method: "GET", auth: { secret: "WEATHER_KEY" } },
    });
    expect(JSON.stringify(doc)).not.toContain(KEY);
  });

  it.skipIf(RUNTIME === "browser")(
    "rebuilds a REST call from its route and adds the deployment's key, which the model never sees",
    async () => {
      const ann = await as("ann");
      const s = await ann.startSession({ project: alpha });
      const from = rest.requests.length;
      const turn = await ann.sendMessage(s.id, {
        content: call("weather__get_forecast", {
          city: "Saint Malo",
          days: 2,
          "X-Units": "metric",
        }),
      });
      expect(rest.requests.slice(from)).toEqual([
        expect.objectContaining({
          method: "GET",
          url: "/v2/cities/Saint%20Malo/forecast?days=2",
          headers: expect.objectContaining({ "x-api-key": KEY, "x-units": "metric" }),
        }),
      ]);
      expect(toolResults(turn)).toEqual([
        expect.objectContaining({ isError: false, secrets: ["WEATHER_KEY"] }),
      ]);
      // The same call through MCP.
      const viaMcp = await mcp(ann, s.id, "tools/call", {
        name: "weather__get_forecast",
        arguments: { city: "Brest" },
      });
      expect(viaMcp.result).toMatchObject({ isError: false });
      expect(rest.requests.at(-1)).toMatchObject({
        url: "/v2/cities/Brest/forecast",
        headers: expect.objectContaining({ "x-api-key": KEY }),
      });
      // An error response is an error result.
      const missing = await ann.sendMessage(s.id, {
        content: call("weather__get_forecast", { city: "nowhere" }),
      });
      expect(toolResults(missing)).toEqual([expect.objectContaining({ isError: true })]);
      const { items } = await ann.listItems(s.id);
      expect(JSON.stringify([items, model.requests, await listed(ann, s.id)])).not.toContain(KEY);
    },
  );

  it.skipIf(RUNTIME === "browser")(
    "an asking tool asks per call, and approving runs exactly that call",
    async () => {
      const mo = await as("mo");
      const s = await mo.startSession({ project: alpha });
      const from = rest.requests.length;
      const turn = await mo.sendMessage(s.id, {
        content: call("weather__add_report", { city: "Paris", text: "sunny" }),
      });
      expect(turn.status).toBe("waiting");
      expect(rest.requests.length).toBe(from);
      const id = String(turn.stop_reason?.approval_ids?.[0]);
      const { approvals } = await mo.listApprovals();
      expect(approvals.find((a) => a.id === id)).toMatchObject({
        permission: "tools.use:weather/add_report",
      });
      const { accepted } = await mo.answerApproval(id, { decision: "allow", scope: "once" });
      const answered = await mo.waitTurn(accepted);
      expect(toolResults(answered).at(-1)).toMatchObject({ isError: false, approval: id });
      expect(rest.requests.slice(from)).toEqual([
        expect.objectContaining({
          method: "POST",
          url: "/v2/reports",
          body: JSON.stringify({ city: "Paris", text: "sunny" }),
          headers: expect.objectContaining({ "x-api-key": KEY }),
        }),
      ]);
      // Over MCP, the call asks too: nothing leaves until the user allows it.
      const before = rest.requests.length;
      const viaMcp = await mcp(mo, s.id, "tools/call", {
        name: "weather__add_report",
        arguments: { city: "Lyon", text: "rain" },
      });
      expect(viaMcp.result).toMatchObject({ isError: true });
      expect(JSON.stringify(viaMcp.result)).toMatch(/approval/);
      expect(rest.requests.length).toBe(before);
    },
  );

  it("refuses a forged call to a tool the session was not offered, in the loop and over MCP", async () => {
    const rita = await as("rita");
    const s = await rita.startSession({ project: alpha });
    const from = rest.requests.length;
    const turn = await rita.sendMessage(s.id, {
      content: call("weather__add_report", { city: "Paris", text: "forged" }),
    });
    expect(toolResults(turn)).toEqual([expect.objectContaining({ isError: true })]);
    const forged = await mcp(rita, s.id, "tools/call", {
      name: "weather__add_report",
      arguments: { city: "Paris", text: "forged" },
    });
    expect(forged.error).toMatchObject({ code: -32602 });
    expect(rest.requests.length).toBe(from);
  });

  it.skipIf(RUNTIME === "browser")(
    "runs read tools in parallel and other tools one at a time",
    async () => {
      const pat = await as("pat");
      await pat.setMode({ mode: "bypassPermissions" });
      try {
        const s = await pat.startSession({ project: alpha });
        rest.delayMs = 150;
        rest.maxInFlight = 0;
        await pat.sendMessage(s.id, {
          content: [
            call("weather__get_forecast", { city: "slow-a" }),
            call("weather__get_forecast", { city: "slow-b" }),
          ].join("\n"),
        });
        expect(rest.maxInFlight).toBe(2);
        rest.maxInFlight = 0;
        await pat.sendMessage(s.id, {
          content: [
            call("weather__add_report", { city: "a", text: "1" }),
            call("weather__add_report", { city: "b", text: "2" }),
          ].join("\n"),
        });
        expect(rest.maxInFlight).toBe(1);
      } finally {
        rest.delayMs = 0;
        await pat.setMode({ mode: "default" });
      }
    },
  );
});
