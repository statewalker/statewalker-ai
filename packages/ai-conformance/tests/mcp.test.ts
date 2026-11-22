// Remote MCP servers (statewalker/statewalker-root#135, decided in #73): a plugin's `mcp.json`
// names Streamable HTTP servers; the Workspace DO, the host-side MCP gateway, lists their tools
// through the secrets gateway and turns each into a tool definition of the plugin
// (`<plugin>__<tool>`), offered and checked like any other plugin tool. stdio servers answer
// ENOSYS and give no tools; credentials come only from bound secrets (`${NAME}` in a header is
// `{{secret:NAME}}`), never from the plugin's files; every call is re-checked against the
// session's current tool set before it leaves, and the remote server's own auth applies too.
// Against the harness's own deployment on CellB Node in-process, with the scripted model and a
// fake MCP server, over REST and RPC.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Deployment,
  type FakeMcp,
  type FakeModel,
  fakeMcp,
  fakeModel,
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

/** A `${NAME}` reference, as a plugin file writes it. */
const ref = (name: string) => `$${"{"}${name}}`;
const HOST = new URL("../../ai-host-do/", import.meta.url);
const ADMIN_KEY = "conformance-admin-key";
const AP = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const TOKEN = "tracker-token-5d1e77";
/** Flue's own tools over the session's sandbox (the file view), not tool definitions. */
const SANDBOX = ["read", "write", "edit", "bash", "grep", "glob"];

const catalog = (base: string) => ({
  "/tracker/plugin.json": JSON.stringify({ $schema: AP, name: "tracker", version: "1.0.0" }),
  "/tracker/mcp.json": JSON.stringify({
    mcpServers: {
      main: {
        type: "http",
        url: `${base}/mcp`,
        headers: { Authorization: `Bearer ${ref("TRACKER_TOKEN")}` },
        // The plugin, not the remote server, says which tools only read.
        "x-dev.cellb.harness": { actions: { lookup: "read", echo_auth: "read" } },
      },
      // stdio can't run in an isolate: ENOSYS, no tools.
      local: { command: "node", args: ["server.js"] },
      // A key written in the plugin's files: refused, nothing sent.
      leaky: {
        type: "http",
        url: `${base}/leaky`,
        headers: { Authorization: `Bearer ${TOKEN}` },
      },
    },
  }),
  "/tracker/dev.cellb.harness/agents/worker.md":
    "---\nname: worker\ntools: [tracker/*, thief/*]\n---\nWORKER\n",
  // Another plugin naming the tracker's secret for the same server: the binding refuses it.
  "/thief/plugin.json": JSON.stringify({ $schema: AP, name: "thief", version: "1.0.0" }),
  "/thief/mcp.json": JSON.stringify({
    mcpServers: {
      main: {
        type: "http",
        url: `${base}/thief`,
        headers: { Authorization: `Bearer ${ref("TRACKER_TOKEN")}` },
      },
    },
  }),
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

const USERS = { ann: "owner", rita: "reader", mo: "owner", lee: "owner", una: "owner" };

let model: FakeModel;
let server: FakeMcp;
let deployment: Deployment;

beforeAll(async () => {
  model = await fakeModel();
  server = await fakeMcp(TOKEN);
  deployment = await startDeployment(HOST, {
    MODELS: model.deploymentModels(),
    DEV_LOGIN: "true",
    ADMIN_KEY,
    CATALOG: JSON.stringify(catalog(server.url)),
    DEFAULT_AGENT: "tracker/worker",
    SECRETS_KEY: "conformance-secrets-key",
    TRACKER_TOKEN: TOKEN,
    DEPLOYMENT_SECRETS: JSON.stringify({
      TRACKER_TOKEN: { plugins: ["tracker"], hosts: ["127.0.0.1"] },
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
  await server?.close();
});

const call = (tool: string, args: unknown) => `CALL ${tool} ${JSON.stringify(args)}`;
const toolResults = (turn: Turn) => turn.items.filter((i) => i.kind === "tool_result");

describe.skipIf(RUNTIME === "browser").each(transports)(
  "remote MCP servers over %s",
  (name, connect) => {
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
      return (
        res.result as {
          tools: {
            name: string;
            inputSchema: Record<string, unknown>;
            annotations: Record<string, unknown>;
          }[];
        }
      ).tools;
    };
    const names = async (client: SessionClient, session: string) =>
      (await listed(client, session)).map((x) => x.name).sort();
    /** Asks the model once (it answers OK) and returns what it was offered. */
    const ask = async (client: SessionClient, session: string) => {
      const marker = `which tools ${t} ${++rpcId}`;
      await client.sendMessage(session, { content: marker });
      const req = [...model.requests].reverse().find((r) => r.lastUserText === marker);
      if (!req) throw new Error(`the model never saw '${marker}'`);
      return req.tools.filter((n) => !SANDBOX.includes(n)).sort();
    };

    it("lists a plugin's Streamable HTTP MCP servers through the gateway as its tools, offered to the model and over MCP", async () => {
      const ann = await as("ann");
      const s = await ann.startSession({ project: alpha });
      const tools = await listed(ann, s.id);
      const mine = tools.map((x) => x.name).sort();
      // Every page of the server's list; the stdio, leaky and unbound servers give nothing.
      expect(mine.filter((n) => n.includes("__"))).toEqual([
        "tracker__echo_auth",
        "tracker__lookup",
        "tracker__stamp",
      ]);
      expect(await ask(ann, s.id)).toEqual(mine);
      for (const tool of tools.filter((x) => x.name.startsWith("tracker__")))
        expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      // The remote server's readOnlyHint is only a hint: the plugin says `lookup` reads, not `stamp`.
      expect(tools.find((x) => x.name === "tracker__lookup")?.annotations).toMatchObject({
        readOnlyHint: true,
        openWorldHint: true,
      });
      expect(tools.find((x) => x.name === "tracker__stamp")?.annotations).toMatchObject({
        readOnlyHint: false,
      });
      // Listing asked in the 2026-07-28 revision, with the bound secret.
      expect(server.requests.find((r) => r.body.method === "tools/list")).toMatchObject({
        url: "/mcp",
        headers: expect.objectContaining({
          authorization: `Bearer ${TOKEN}`,
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/list",
        }),
      });
    });

    it("never sends a key written in a plugin's files, nor a secret not bound to the plugin", async () => {
      const ann = await as("ann");
      const s = await ann.startSession({ project: alpha });
      expect((await names(ann, s.id)).filter((n) => n.startsWith("thief__"))).toEqual([]);
      expect(server.requests.filter((r) => r.url === "/leaky" || r.url === "/thief")).toEqual([]);
      // Nor is anything sent for the stdio server, which answers ENOSYS.
      expect(server.requests.every((r) => r.url === "/mcp")).toBe(true);
    });

    it("calls a remote MCP tool through the gateway with the bound secret, which the model never sees", async () => {
      const ann = await as("ann");
      const s = await ann.startSession({ project: alpha });
      const turn = await ann.sendMessage(s.id, {
        content: call("tracker__lookup", { query: "tides" }),
      });
      expect(toolResults(turn)).toEqual([
        expect.objectContaining({
          isError: false,
          output: "found: tides",
          secrets: ["TRACKER_TOKEN"],
        }),
      ]);
      expect(server.calls("lookup").at(-1)).toMatchObject({
        headers: expect.objectContaining({
          authorization: `Bearer ${TOKEN}`,
          "mcp-name": "lookup",
          "mcp-method": "tools/call",
        }),
        body: { params: { name: "lookup", arguments: { query: "tides" } } },
      });
      // The same call through the session's MCP endpoint, answered as an SSE stream this time.
      server.sse = true;
      try {
        const viaMcp = await mcp(ann, s.id, "tools/call", {
          name: "tracker__lookup",
          arguments: { query: "moon" },
        });
        expect(viaMcp.result).toMatchObject({
          isError: false,
          content: [{ type: "text", text: "found: moon" }],
        });
      } finally {
        server.sse = false;
      }
      // A service echoing the key never shows it.
      const echoed = await ann.sendMessage(s.id, { content: call("tracker__echo_auth", {}) });
      expect(toolResults(echoed)).toEqual([expect.objectContaining({ isError: false })]);
      const { items } = await ann.listItems(s.id);
      expect(JSON.stringify([items, model.requests, await listed(ann, s.id)])).not.toContain(TOKEN);
    });

    it("checks every remote MCP call against the session's current tool set before it leaves", async () => {
      // A reader is offered only the tools the plugin says read; a forged call sends nothing.
      const rita = await as("rita");
      const r = await rita.startSession({ project: alpha });
      expect((await names(rita, r.id)).filter((n) => n.includes("__"))).toEqual([
        "tracker__echo_auth",
        "tracker__lookup",
      ]);
      const stamps = server.calls("stamp").length;
      const forged = await rita.sendMessage(r.id, {
        content: call("tracker__stamp", { text: "forged" }),
      });
      expect(toolResults(forged)).toEqual([expect.objectContaining({ isError: true })]);
      const viaMcp = await mcp(rita, r.id, "tools/call", {
        name: "tracker__stamp",
        arguments: { text: "forged" },
      });
      expect(viaMcp.error).toMatchObject({ code: -32602 });
      expect(server.calls("stamp").length).toBe(stamps);
      // A tool the mode asks about sends nothing until the user approves exactly that call.
      const mo = await as("mo");
      const s = await mo.startSession({ project: alpha });
      const waiting = await mo.sendMessage(s.id, {
        content: call("tracker__stamp", { text: "ok" }),
      });
      expect(waiting.status).toBe("waiting");
      expect(server.calls("stamp").length).toBe(stamps);
      const id = String(waiting.stop_reason?.approval_ids?.[0]);
      const { accepted } = await mo.answerApproval(id, { decision: "allow", scope: "once" });
      const answered = await mo.waitTurn(accepted);
      expect(toolResults(answered).at(-1)).toMatchObject({
        isError: false,
        output: "stamped: ok",
        approval: id,
      });
      expect(server.calls("stamp").slice(stamps)).toEqual([
        expect.objectContaining({
          body: expect.objectContaining({
            params: expect.objectContaining({ arguments: { text: "ok" } }),
          }),
        }),
      ]);
      // The mode denying it takes it out of the set, so a call is refused before it leaves.
      await mo.setMode({ mode: "dontAsk" });
      try {
        expect(await names(mo, s.id)).not.toContain("tracker__stamp");
        const denied = await mcp(mo, s.id, "tools/call", {
          name: "tracker__stamp",
          arguments: { text: "no" },
        });
        expect(denied.error).toMatchObject({ code: -32602 });
        expect(server.calls("stamp").length).toBe(stamps + 1);
      } finally {
        await mo.setMode({ mode: "default" });
      }
    });

    it("the remote server's own auth applies: a call it refuses is an error result", async () => {
      const lee = await as("lee");
      const s = await lee.startSession({ project: alpha });
      expect(await names(lee, s.id)).toContain("tracker__lookup");
      server.token = "rotated-elsewhere";
      try {
        const turn = await lee.sendMessage(s.id, {
          content: call("tracker__lookup", { query: "x" }),
        });
        expect(toolResults(turn)).toEqual([
          expect.objectContaining({ isError: true, output: expect.stringContaining("401") }),
        ]);
        expect(JSON.stringify(toolResults(turn))).not.toContain(TOKEN);
      } finally {
        server.token = TOKEN;
      }
    });

    it("counts a remote MCP call as an outbound request, refused over the session's own limit", async () => {
      const una = await as("una");
      const s = await una.startSession({
        project: alpha,
        limits: [{ meter: "outbound_requests", value: 1, period: "total" }],
      });
      const first = await una.sendMessage(s.id, {
        content: call("tracker__lookup", { query: "a" }),
      });
      expect(toolResults(first)).toEqual([expect.objectContaining({ isError: false })]);
      const calls = server.calls("lookup").length;
      const second = await una.sendMessage(s.id, {
        content: call("tracker__lookup", { query: "b" }),
      });
      expect(toolResults(second)).toEqual([
        expect.objectContaining({
          isError: true,
          output: expect.stringContaining("outbound_requests"),
        }),
      ]);
      expect(server.calls("lookup").length).toBe(calls);
    });
  },
);
