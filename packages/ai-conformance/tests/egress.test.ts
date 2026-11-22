// The egress gateway (statewalker/statewalker-root#208, decided in #161): executed code reaches the
// network only through one host-side gateway, and only where four conditions all allow it: the
// deployment allowlist (EGRESS_ALLOW), the user's `net.*` roles (held by no built-in role), the
// agent's `requires.network` declaration, and the mode (`default` asks on first use, per host for
// reads and per host and path prefix for writes; `acceptEdits` allows reads; `plan` denies; `auto`
// classifies a summary; unattended sessions deny what would ask). The gateway resolves names
// itself and refuses internal and metadata addresses (through redirects too), puts bound secrets
// in only for their hosts, caps requests and answers, counts each request toward the outbound
// meter and records it as an item without headers or bodies. REST tools get the same address rule.
// Against the harness's own deployment, with the scripted model, over REST and RPC.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CAN,
  type Deployment,
  type FakeModel,
  type FakeRest,
  fakeModel,
  fakeRest,
  login,
  RUNTIME,
  restClient,
  rpcClient,
  type SessionClient,
  seed,
  startDeployment,
  type Turn,
} from "../src/index.js";

const HOST = new URL("../../ai-host-do/", import.meta.url);
const ADMIN_KEY = "conformance-admin-key";
const AP = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const CLASSIFIER = "scripted/classifier";

/** Hosts the gateway must refuse whatever the allowlist, roles and declaration say. */
const INSIDE = ["169.254.169.254", "10.0.0.1", "localhost", "inside.test"];

const agent = (name: string, requires: unknown) =>
  `---\nname: ${name}\nrequires: ${JSON.stringify(requires)}\n---\n${name.toUpperCase()}\n`;

const CATALOG = {
  "/net/plugin.json": JSON.stringify({ $schema: AP, name: "net", version: "1.0.0" }),
  // Declares reads under /api and writes under /api/post on the fake server, and the internal hosts.
  "/net/dev.cellb.harness/agents/fetcher.md": agent("fetcher", {
    node: true,
    network: [
      { host: "127.0.0.1", path: "/api" },
      { host: "127.0.0.1", path: "/api/post", write: true },
      { host: "127.0.0.1", path: "/redirect" },
      ...INSIDE.map((host) => ({ host })),
    ],
  }),
  // Uses the project's native tool, which declares its own network.
  "/net/dev.cellb.harness/agents/geofetch.md": "---\nname: geofetch\ntools: [geo/*]\n---\nGEO\n",
  // Declares nothing: its code has no network.
  "/net/dev.cellb.harness/agents/quiet.md": agent("quiet", { node: true }),
  // A REST tool whose server is the cloud's metadata address.
  "/meta/plugin.json": JSON.stringify({ $schema: AP, name: "meta", version: "1.0.0" }),
  "/meta/dev.cellb.harness/tools/rest/meta.json": JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Meta", version: "1" },
    servers: [{ url: "https://169.254.169.254/latest" }],
    paths: {
      "/meta-data": {
        get: {
          operationId: "getMeta",
          summary: "Instance metadata",
          responses: { 200: { description: "ok" } },
        },
      },
    },
  }),
  "/meta/dev.cellb.harness/agents/meta.md": "---\nname: meta\ntools: [meta/*]\n---\nMETA\n",
};

/** One script for every request: `node net.mjs <url> [method] [@file|body] [authorization]`. */
const NET_SCRIPT = `
import { readFile } from "node:fs/promises";
const [url, method = "GET", data, auth] = process.argv.slice(2);
const body = data ? (data.startsWith("@") ? await readFile(data.slice(1), "utf8") : data) : undefined;
try {
  const r = await fetch(url, { method, ...(body ? { body } : {}), headers: auth ? { authorization: auth } : {} });
  console.log("status " + r.status + " " + (await r.text()).slice(0, 400));
} catch (e) {
  console.log("refused: " + String(e.message));
}`;

/** Python through the gateway (Pyodide's pyfetch), and a raw socket, which stays closed. */
const PY_SCRIPT = [
  "import sys",
  "from pyodide.http import pyfetch",
  "try:",
  "    r = await pyfetch(sys.argv[1])",
  "    print('status', r.status, await r.text())",
  "except Exception as e:",
  "    print('refused:', e)",
].join("\n");
const PY_SOCKET = [
  "import socket, sys",
  "try:",
  "    socket.create_connection(('127.0.0.1', int(sys.argv[1])), timeout=3)",
  "    print('connected')",
  "except Exception as e:",
  "    print('no socket:', type(e).__name__)",
].join("\n");

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
let server: FakeRest;
let deployment: Deployment;

const models = () =>
  JSON.stringify({
    providers: [{ id: "scripted", api: "openai-completions", baseUrl: model.url }],
    models: [{ id: "scripted/default", alias: "default" }, { id: CLASSIFIER }],
    default: "scripted/default",
  });

const vars = (extra: Record<string, string> = {}) => ({
  MODELS: models(),
  DEV_LOGIN: "true",
  ADMIN_KEY,
  CATALOG: JSON.stringify(CATALOG),
  DEFAULT_AGENT: "net/fetcher",
  SECRETS_KEY: "conformance-secrets-key",
  AUTO_MODE: JSON.stringify({ model: CLASSIFIER, timeout_ms: 3000 }),
  EGRESS_ALLOW: ["127.0.0.1/api", "127.0.0.1/redirect", ...INSIDE].join(","),
  EGRESS_TEST_HOSTS: JSON.stringify({ "inside.test": ["127.0.0.1"] }),
  EGRESS_MAX_RESPONSE_BYTES: "2000",
  EGRESS_MAX_BODY_BYTES: "200",
  EGRESS_MAX_QUERY_BYTES: "300",
  ...extra,
});

/** The scripts the operator approves on CellB Node, by the hashes their refusals name. */
async function approvedHashes(): Promise<string> {
  const probe = await startDeployment(HOST, vars());
  try {
    await seed(probe, ADMIN_KEY, {
      "/probe/.system/access": JSON.stringify({ "ann-probe": "owner" }),
      "/probe/net.mjs": NET_SCRIPT,
    });
    const ann = await restClient(probe, await login(probe, "ann-probe"));
    await ann.setMode({ mode: "bypassPermissions" });
    const s = await ann.startSession({ project: "probe" });
    const out = outputOf(await ann.sendMessage(s.id, { content: bash("node net.mjs") }));
    const hash = /sha256 ([0-9a-f]{64}), which is not approved/.exec(out)?.[1];
    if (!hash) throw new Error(`no refusal naming a hash: ${out}`);
    return hash;
  } finally {
    await probe.close();
  }
}

const NETTER = ["net.fetch:127.0.0.1", ...INSIDE.map((h) => `net.fetch:${h}`)];

beforeAll(async () => {
  model = await fakeModel();
  server = await fakeRest();
  const approved = RUNTIME === "node" ? await approvedHashes() : "";
  deployment = await startDeployment(HOST, vars({ APPROVED_BUNDLES: approved }));
  const files: Record<string, string> = {};
  for (const t of ["rest", "rpc"]) {
    const p = `/net-${t}`;
    // ann holds net.* through a custom role; own is an owner, which holds none.
    files[`${p}/.system/access`] = JSON.stringify({
      [`ann-${t}`]: "netter",
      [`own-${t}`]: "owner",
      [`una-${t}`]: "netter",
    });
    files[`${p}/.system/roles`] = JSON.stringify({ netter: ["role:owner", ...NETTER] });
    // Running code is allowed here in every mode, so the network is what the mode decides.
    files[`${p}/.system/permission-rules`] = JSON.stringify({ allow: ["code.run"] });
    files[`${p}/net.mjs`] = NET_SCRIPT;
    files[`${p}/net.py`] = PY_SCRIPT;
    files[`${p}/sock.py`] = PY_SOCKET;
    files[`${p}/body.txt`] = "the-private-body-text";
    // A project plugin's native tool, declaring reads of the fake server's /api in its operation.
    const geo = `${p}/.system/plugins/geo`;
    files[`${geo}/plugin.json`] = JSON.stringify({ $schema: AP, name: "geo" });
    files[`${geo}/dev.cellb.harness/tools/openapi.json`] = JSON.stringify({
      openapi: "3.1.0",
      info: { title: "geo", version: "1" },
      paths: {
        "/lookup": {
          post: {
            operationId: "lookup",
            summary: "Looks a URL up",
            "x-dev.cellb.harness": {
              action: "read",
              requires: { network: [{ host: "127.0.0.1", path: "/api" }] },
            },
            requestBody: {
              content: {
                "application/json": {
                  schema: { type: "object", properties: { url: { type: "string" } } },
                },
              },
            },
          },
        },
      },
    });
    files[`${geo}/dev.cellb.harness/tools/lookup.js`] = `
      export default async function execute(input, ctx) {
        try {
          const r = await ctx.fetch(input.url);
          return "status " + r.status + " " + (await r.text());
        } catch (e) {
          return "refused: " + e.message;
        }
      }`;
    files[`/meter-${t}/.system/access`] = JSON.stringify({ [`ann-${t}`]: "netter" });
    files[`/meter-${t}/.system/roles`] = JSON.stringify({ netter: ["role:owner", ...NETTER] });
    files[`/meter-${t}/net.mjs`] = NET_SCRIPT;
    files[`/meter-${t}/.system/limits`] = JSON.stringify([
      { meter: "outbound_requests", level: "project", value: 1, period: "day" },
    ]);
  }
  await seed(deployment, ADMIN_KEY, files);
}, 180_000);
afterAll(async () => {
  for (const s of sockets) s.close();
  await deployment?.close();
  await server?.close();
  await model?.close();
});

const call = (tool: string, args: unknown) => `CALL ${tool} ${JSON.stringify(args)}`;
const bash = (command: string) => call("bash", { command });
const results = (turn: Turn) => turn.items.filter((i) => i.kind === "tool_result");
const outputOf = (turn: Turn) => String(results(turn).at(-1)?.output);
const networkItems = (turn: Turn) => turn.items.filter((i) => i.kind === "network_request");

describe.each(transports)("the egress gateway over %s", (name, connect) => {
  const t = name.toLowerCase();
  const project = `net-${t}`;
  const as = async (user: string, mode = "bypassPermissions") => {
    const client = await connect(deployment, await login(deployment, `${user}-${t}`));
    await client.setMode({ mode });
    return client;
  };
  const api = (path: string) => `${server.url}/api${path}`;
  const seen = (marker: string) => server.requests.filter((r) => r.url.includes(marker));

  it("sends a node script's request when the allowlist, the roles, the declaration and the mode allow it, recording an item without headers or bodies", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project });
    const marker = `ok-${t}`;
    const turn = await ann.sendMessage(s.id, {
      content: bash(`node net.mjs ${api(`/${marker}?q=1`)}`),
    });
    expect(outputOf(turn)).toContain('status 200 {"ok":true}');
    expect(seen(marker)).toHaveLength(1);
    const [item] = networkItems(turn);
    expect(item?.network).toMatchObject({
      method: "GET",
      host: "127.0.0.1",
      path: `/api/${marker}`,
      status: 200,
      executor: "isolate",
    });
    expect(JSON.stringify(item)).not.toContain("q=1");
    expect(JSON.stringify(item)).not.toContain("authorization");
  });

  it("refuses what the allowlist leaves out, what the agent does not declare, and an agent declaring nothing: the server sees nothing", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project });
    const other = `${server.url}/other-${t}`;
    expect(
      outputOf(await ann.sendMessage(s.id, { content: bash(`node net.mjs ${other}`) })),
    ).toMatch(/refused: .*EACCES: the deployment allows no network to 127\.0\.0\.1/);
    const write = api(`/w-${t}`);
    expect(
      outputOf(await ann.sendMessage(s.id, { content: bash(`node net.mjs ${write} POST hello`) })),
    ).toMatch(/refused: .*does not declare writes/);
    const quiet = await ann.startSession({ project, agent: "net/quiet" });
    expect(
      outputOf(
        await ann.sendMessage(quiet.id, { content: bash(`node net.mjs ${api(`/q-${t}`)}`) }),
      ),
    ).toMatch(/refused: .*does not declare/);
    expect(
      server.requests.filter((r) => r.url.includes(`-${t}`) && /other|\/w-|\/q-/.test(r.url)),
    ).toEqual([]);
  });

  it("refuses a user whose roles hold no net.* grant: an owner holds none", async () => {
    const own = await as("own");
    const s = await own.startSession({ project });
    const turn = await own.sendMessage(s.id, { content: bash(`node net.mjs ${api(`/own-${t}`)}`) });
    expect(outputOf(turn)).toMatch(
      /refused: .*EACCES: may not reach GET 127\.0\.0\.1\/api\/own-.*net\.read/,
    );
    expect(seen(`own-${t}`)).toEqual([]);
  });

  it("refuses internal and metadata addresses, names resolving inside and redirects to them, whatever is granted", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project });
    for (const host of INSIDE) {
      const out = outputOf(
        await ann.sendMessage(s.id, { content: bash(`node net.mjs https://${host}/latest`) }),
      );
      expect(out, host).toMatch(/refused: .*EACCES: .*internal address/);
    }
    for (const to of [
      "http://169.254.169.254/latest/meta-data",
      "https://inside.test/x",
      "https://10.0.0.1/",
    ]) {
      const url = `${server.url}/redirect?to=${encodeURIComponent(to)}&m=${t}`;
      const out = outputOf(await ann.sendMessage(s.id, { content: bash(`node net.mjs "${url}"`) }));
      expect(out, to).toMatch(/refused: .*EACCES: .*(internal address|https requests only)/);
    }
  });

  it("puts a bound secret in only for its host, and the code never sees its value", async () => {
    if (!CAN.deploymentSecrets) return;
    const ann = await as("ann");
    await ann.setSecret({
      level: "user",
      name: "NET_KEY",
      value: `key-value-${t}-5e1f`,
      bindings: { plugins: ["net"], hosts: ["127.0.0.1"] },
    });
    const s = await ann.startSession({ project });
    const turn = await ann.sendMessage(s.id, {
      content: bash(`node net.mjs ${api(`/echo-${t}`)} GET "" "Bearer {{secret:NET_KEY}}"`),
    });
    const sent = seen(`echo-${t}`)[0];
    expect(sent?.headers.authorization).toBe(`Bearer key-value-${t}-5e1f`);
    expect(outputOf(turn)).toContain("status 200");
    expect(JSON.stringify(turn.items)).not.toContain(`key-value-${t}-5e1f`);
    // Not bound to another host: refused, nothing sent there.
    const away = await ann.sendMessage(s.id, {
      content: bash(`node net.mjs https://inside.test/x GET "" "Bearer {{secret:NET_KEY}}"`),
    });
    expect(outputOf(away)).toMatch(/refused: .*EACCES/);
  });

  it("caps the request body, the query string and the response", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project });
    const out = async (cmd: string) =>
      outputOf(await ann.sendMessage(s.id, { content: bash(cmd) }));
    expect(await out(`node net.mjs ${api(`/post/b-${t}`)} POST ${"b".repeat(300)}`)).toMatch(
      /refused: .*E2BIG: the request body/,
    );
    expect(await out(`node net.mjs "${api(`/q2-${t}?q=${"x".repeat(400)}`)}"`)).toMatch(
      /refused: .*E2BIG: the query string/,
    );
    expect(await out(`node net.mjs "${api(`/big?n=5000`)}"`)).toMatch(
      /refused: .*E2BIG: the response/,
    );
  });

  it("counts each request toward the outbound-requests limit, and refuses past it before sending", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project: `meter-${t}` });
    const first = await ann.sendMessage(s.id, { content: bash(`node net.mjs ${api(`/m1-${t}`)}`) });
    expect(outputOf(first)).toContain("status 200");
    const second = await ann.sendMessage(s.id, {
      content: bash(`node net.mjs ${api(`/m2-${t}`)}`),
    });
    expect(outputOf(second)).toMatch(/refused: .*ELIMIT/);
    expect(seen(`m2-${t}`)).toEqual([]);
  });

  it("asks in default mode on first use per host, runs again once approved, and 'allow for this session' covers later reads", async () => {
    const ann = await as("ann", "default");
    const s = await ann.startSession({ project });
    // Running code is asked about first (code.run), approved for the session.
    const first = await ann.sendMessage(s.id, { content: bash(`node net.mjs ${api(`/d1-${t}`)}`) });
    let approval = first.items.find((i) => i.kind === "approval")?.request;
    if (approval?.permission === "code.run:node") {
      const ran = await ann.answerApproval(approval.id, { decision: "allow", scope: "session" });
      const next = await ann.waitTurn(ran.accepted);
      approval = next.items.find((i) => i.kind === "approval")?.request;
    }
    expect(approval).toMatchObject({
      permission: "net.read:127.0.0.1",
      action: { method: "fetch" },
    });
    expect(seen(`d1-${t}`)).toEqual([]);
    const answered = await ann.answerApproval(String(approval?.id), {
      decision: "allow",
      scope: "session",
    });
    const rerun = await ann.waitTurn(answered.accepted);
    expect(JSON.stringify(rerun.items)).toContain('status 200 {\\"ok\\":true}');
    expect(seen(`d1-${t}`)).toHaveLength(1);
    const later = await ann.sendMessage(s.id, { content: bash(`node net.mjs ${api(`/d2-${t}`)}`) });
    expect(outputOf(later)).toContain("status 200");
  });

  it("allows reads and asks writes in acceptEdits; denies both in plan", async () => {
    const ann = await as("ann", "acceptEdits");
    await ann.setMode({ mode: "acceptEdits" });
    const s = await ann.startSession({ project });
    // code.run asks in acceptEdits: allow it for the session first.
    const run = async (cmd: string) => {
      let turn = await ann.sendMessage(s.id, { content: bash(cmd) });
      const asked = turn.items.find((i) => i.kind === "approval")?.request;
      if (asked?.permission === "code.run:node") {
        const a = await ann.answerApproval(asked.id, { decision: "allow", scope: "session" });
        turn = await ann.waitTurn(a.accepted);
      }
      return turn;
    };
    const read = await run(`node net.mjs ${api(`/ae-${t}`)}`);
    expect(JSON.stringify(read.items)).toContain("status 200");
    const write = await run(`node net.mjs ${api(`/post/ae-${t}`)} POST hi`);
    expect(write.items.find((i) => i.kind === "approval")?.request).toMatchObject({
      permission: "net.write:127.0.0.1/api/post",
    });
    expect(seen(`post/ae-${t}`)).toEqual([]);
    await ann.setMode({ mode: "plan" });
    const planned = await run(`node net.mjs ${api(`/plan-${t}`)}`);
    expect(JSON.stringify(planned.items)).toMatch(/refused: .*EACCES: may not reach/);
    expect(seen(`plan-${t}`)).toEqual([]);
  });

  it("denies in an unattended session what default mode would ask", async () => {
    const una = await as("una", "default");
    const s = await una.startSession({ project, unattended: true });
    const turn = await una.sendMessage(s.id, { content: bash(`node net.mjs ${api(`/un-${t}`)}`) });
    expect(turn.items.some((i) => i.kind === "approval")).toBe(false);
    expect(outputOf(turn)).toMatch(/refused: .*EACCES: may not reach .*unattended/);
    expect(seen(`un-${t}`)).toEqual([]);
  });

  it("has auto mode's classifier decide from a summary: method, host, path and size, never the body", async () => {
    const ann = await as("ann", "auto");
    const s = await ann.startSession({ project });
    await ann.sendMessage(s.id, { content: "post the body file. CLASSIFY allow" });
    const turn = await ann.sendMessage(s.id, {
      content: bash(`node net.mjs ${api(`/post/auto-${t}`)} POST @body.txt`),
    });
    expect(JSON.stringify(turn.items)).toContain("status 200");
    expect(seen(`post/auto-${t}`)[0]?.body).toBe("the-private-body-text");
    const asked = model.requests.filter((r) => r.classifier).at(-1);
    const shown = JSON.stringify(asked);
    expect(shown).toContain(`127.0.0.1/api/post/auto-${t}`);
    expect(shown).not.toContain("the-private-body-text");
  });

  it("lets a native tool reach only what its operation declares, through the gateway, recording an item", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project, agent: "net/geofetch" });
    const ok = await ann.sendMessage(s.id, { content: call("geo__lookup", { url: api(`/geo-${t}`) }) });
    expect(outputOf(ok)).toContain('status 200 {"ok":true}');
    expect(networkItems(ok)[0]?.network).toMatchObject({ executor: "isolate", status: 200 });
    const refused = await ann.sendMessage(s.id, {
      content: call("geo__lookup", { url: `${server.url}/redirect?to=x&geo=${t}` }),
    });
    expect(outputOf(refused)).toMatch(/refused: .*does not declare/);
    expect(seen(`geo=${t}`)).toEqual([]);
  });

  it("refuses a REST tool at the cloud's metadata address, sending nothing", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project, agent: "meta/meta" });
    const turn = await ann.sendMessage(s.id, { content: call("meta__get_meta", {}) });
    expect(outputOf(turn)).toMatch(/EACCES: .*(internal address|169\.254\.169\.254)/);
  });

  it("lets no executor reach the network directly: python's sockets stay closed and curl goes through the gateway", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project });
    const curl = await ann.sendMessage(s.id, { content: bash(`curl -s ${api(`/curl-${t}`)}`) });
    expect(outputOf(curl)).toContain('{"ok":true}');
    expect(networkItems(curl)[0]?.network).toMatchObject({ executor: "shell", status: 200 });
    const refused = await ann.sendMessage(s.id, {
      content: bash(`curl -sS ${server.url}/nope-${t}`),
    });
    expect(outputOf(refused)).toMatch(/EACCES: the deployment allows no network/);
    expect(seen(`nope-${t}`)).toEqual([]);
    if (!CAN.python) return;
    const py = await ann.sendMessage(s.id, { content: bash(`python net.py ${api(`/py-${t}`)}`) });
    expect(outputOf(py)).toContain('status 200 {"ok":true}');
    expect(networkItems(py)[0]?.network).toMatchObject({ executor: "engine", status: 200 });
    const before = server.requests.length;
    const sock = await ann.sendMessage(s.id, { content: bash(`python sock.py ${server.port}`) });
    expect(outputOf(sock)).toContain("no socket:");
    expect(server.requests.length).toBe(before);
  });
});
