// Native tool scripts in isolates (statewalker/statewalker-root#130, decided in #82 and #94):
// plugin authors write tools as scripts beside the tools' OpenAPI file (one per operation, each
// default-exporting `execute(input, ctx)`), or OpenCode-style without one (the harness generates
// the document). The harness bundles them with webrun-bundler, names each bundle by its content
// hash, and runs each call by RPC in a Worker Loader isolate of its own: no network, and only the
// files and databases of the capability it is given (the session's, narrowed to the tool). The
// isolate's time is metered (`executor_cpu_ms:isolate`) and the run is ended when a limit refuses
// it or its timeout passes. Deployment catalog bundles run only once approved by hash; workspace
// and project plugins pass the acceptance check, and adding them approves them. Python scripts are
// recorded and answer ENOSYS. Against the harness's own deployment on CellB Node in-process, with
// the scripted model, over REST and RPC.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Deployment,
  type FakeModel,
  fakeModel,
  login,
  type McpResponse,
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
const TOOLS = "dev.cellb.harness/tools";

const op = (id: string, props: Record<string, unknown> = {}, action?: string) => ({
  post: {
    operationId: id,
    summary: `the ${id} tool`,
    ...(action ? { "x-dev.cellb.harness": { action } } : {}),
    requestBody: {
      content: { "application/json": { schema: { type: "object", properties: props } } },
    },
  },
});

/** A project plugin: an OpenAPI file and one script per operation. */
const projectPlugin = (root: string) => ({
  [`${root}/proj/plugin.json`]: JSON.stringify({ $schema: AP, name: "proj" }),
  [`${root}/proj/${TOOLS}/openapi.json`]: JSON.stringify({
    openapi: "3.1.0",
    info: { title: "proj", version: "1" },
    paths: {
      "/count": op("count_words", { path: { type: "string" } }, "read"),
      "/note": op("note", { path: { type: "string" }, text: { type: "string" } }),
      "/spin": op("spin", {}, "read"),
      "/boom": op("boom", {}, "read"),
      "/py": op("py_sum", { a: { type: "number" } }, "read"),
      "/remember": op("remember", { term: { type: "string" } }, "read"),
    },
  }),
  [`${root}/proj/${TOOLS}/lib/words.ts`]:
    "export const words = (text: string): number => text.split(/\\s+/).filter(Boolean).length;",
  [`${root}/proj/${TOOLS}/count_words.ts`]: `
    import { words } from "./lib/words";
    export default async function execute(input: { path: string }, ctx: any) {
      let text = "";
      for await (const chunk of ctx.files.read(input.path)) text += new TextDecoder().decode(chunk);
      return { words: words(text), exists: await ctx.files.exists(input.path) };
    }`,
  [`${root}/proj/${TOOLS}/note.js`]: `
    export default async function execute(input, ctx) {
      await ctx.files.write(input.path, [new TextEncoder().encode(input.text)]);
      const listed = [];
      for await (const e of ctx.files.list(input.path.replace(/\\/[^/]*$/, ""))) listed.push(e.name);
      return { written: input.path, listed };
    }`,
  [`${root}/proj/${TOOLS}/spin.js`]: `
    export default async function execute(input, ctx) {
      while (!ctx.signal.aborted) await new Promise((r) => setTimeout(r, 20));
      return "stopped";
    }`,
  [`${root}/proj/${TOOLS}/boom.js`]: `
    export default async function execute(input, ctx) {
      ctx.log("about to fail");
      throw new Error("the boom tool failed");
    }`,
  [`${root}/proj/${TOOLS}/py_sum.py`]: "def execute(input, ctx):\n    return input['a']\n",
  [`${root}/proj/${TOOLS}/remember.js`]: `
    export default async function execute(input, ctx) {
      const db = ctx.db("memory");
      await db.exec("CREATE TABLE IF NOT EXISTS terms (term TEXT)");
      await db.exec("INSERT INTO terms VALUES ('" + input.term.replace(/'/g, "''") + "')");
      return await db.query("SELECT term FROM terms ORDER BY term");
    }`,
  // OpenCode-style: no OpenAPI file; each tool says what it is.
  [`${root}/oc/plugin.json`]: JSON.stringify({ $schema: AP, name: "oc" }),
  [`${root}/oc/${TOOLS}/shout.ts`]: `
    export default {
      description: "Shouts the text",
      args: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      async execute(args: { text: string }) { return args.text.toUpperCase() + "!"; },
    };`,
  // Scripts and operations that don't match: the build fails, the plugin is not loaded.
  [`${root}/odd/plugin.json`]: JSON.stringify({ $schema: AP, name: "odd" }),
  [`${root}/odd/${TOOLS}/openapi.json`]: JSON.stringify({
    openapi: "3.1.0",
    info: { title: "odd", version: "1" },
    paths: { "/a": op("lonely") },
  }),
  [`${root}/odd/${TOOLS}/stray.js`]: "export default async () => 1;",
  // A script reaching outside the language: refused by the acceptance check.
  [`${root}/sly/plugin.json`]: JSON.stringify({ $schema: AP, name: "sly" }),
  [`${root}/sly/${TOOLS}/openapi.json`]: JSON.stringify({
    openapi: "3.1.0",
    info: { title: "sly", version: "1" },
    paths: { "/env": op("env", {}, "read") },
  }),
  [`${root}/sly/${TOOLS}/env.js`]: "export default async () => process.env;",
});

/** The deployment's catalog: a plugin needing approval by hash, and the default agent. */
const CATALOG = {
  "/calc/plugin.json": JSON.stringify({ $schema: AP, name: "calc", version: "1.0.0" }),
  "/calc/dev.cellb.harness/agents/default.md":
    "---\nname: default\ntools: [calc/*, proj/*, oc/*, odd/*, sly/*]\n---\nDEFAULT\n",
  [`/calc/${TOOLS}/openapi.json`]: JSON.stringify({
    openapi: "3.1.0",
    info: { title: "calc", version: "1" },
    paths: {
      "/add": op("add", { a: { type: "number" }, b: { type: "number" } }, "read"),
      "/net": op("net", {}, "read"),
    },
  }),
  [`/calc/${TOOLS}/add.ts`]:
    "export default async function execute(i: { a: number; b: number }) { return { sum: i.a + i.b }; }",
  // Catalog code is not held to the acceptance check; the isolate's network is off all the same.
  [`/calc/${TOOLS}/net.js`]: `
    export default async function execute() {
      try { await fetch("https://example.com/"); return "reached the network"; }
      catch (e) { return "no network: " + e.message; }
    }`,
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

const vars = (model: FakeModel, extra: Record<string, string> = {}) => ({
  MODELS: model.deploymentModels(),
  DEV_LOGIN: "true",
  ADMIN_KEY,
  CATALOG: JSON.stringify(CATALOG),
  DEFAULT_AGENT: "calc/default",
  TOOL_TIMEOUT_MS: "1500",
  ...extra,
});

let model: FakeModel;
let deployment: Deployment;

beforeAll(async () => {
  model = await fakeModel();
  deployment = await startDeployment(HOST, vars(model));
  const files: Record<string, string> = {};
  for (const t of ["rest", "rpc"]) {
    const owners = (...u: string[]) =>
      JSON.stringify(Object.fromEntries(u.map((x) => [`${x}-${t}`, "owner"])));
    for (const p of [`tools-${t}`, `meter-${t}`]) {
      Object.assign(files, projectPlugin(`/${p}/.system/plugins`));
      files[`/${p}/.system/access`] = owners("ann", "bea", "cy");
      files[`/${p}/doc.txt`] = "one two three four";
    }
    files[`/other-${t}/.system/access`] = owners("ann");
    files[`/other-${t}/secret.txt`] = "not yours";
    files[`/meter-${t}/.system/limits`] = JSON.stringify([
      { meter: "executor_cpu_ms:isolate", level: "project", value: 600, period: "day" },
    ]);
  }
  await seed(deployment, ADMIN_KEY, files);
}, 120_000);
afterAll(async () => {
  for (const s of sockets) s.close();
  await deployment?.close();
  await model?.close();
});

const call = (tool: string, args: unknown) => `CALL ${tool} ${JSON.stringify(args)}`;
const results = (turn: Turn) => turn.items.filter((i) => i.kind === "tool_result");
const outputOf = (turn: Turn) => String(results(turn)[0]?.output);

async function usageRecords(d: Deployment): Promise<Record<string, unknown>[]> {
  const res = await d.fetch("/admin/workspaces/default/usage-records", {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN_KEY}`, "content-type": "application/json" },
    body: "{}",
  });
  return ((await res.json()) as { records: Record<string, unknown>[] }).records;
}

describe.each(transports)("native tools over %s", (name, connect) => {
  const t = name.toLowerCase();
  const project = `tools-${t}`;
  const as = async (user: string) => connect(deployment, await login(deployment, `${user}-${t}`));
  let rpcId = 0;
  const listed = async (client: SessionClient, session: string) => {
    const res = (await client.mcp(session, {
      jsonrpc: "2.0",
      id: ++rpcId,
      method: "tools/list",
    })) as McpResponse;
    return (res.result as { tools: { name: string; inputSchema: Record<string, unknown> }[] })
      .tools;
  };

  it("runs an operation's script in an isolate, with the session's files and only those", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project });
    const turn = await ann.sendMessage(s.id, {
      content: call("proj__count_words", { path: `/${project}/doc.txt` }),
    });
    expect(results(turn)).toEqual([expect.objectContaining({ isError: false })]);
    expect(JSON.parse(outputOf(turn))).toEqual({ words: 4, exists: true });
    // Another project's files are not the capability's.
    const other = await ann.sendMessage(s.id, {
      content: call("proj__count_words", { path: `/other-${t}/secret.txt` }),
    });
    expect(results(other)).toEqual([expect.objectContaining({ isError: true })]);
    expect(outputOf(other)).not.toContain("not yours");
  });

  /** Sends a call the mode asks about, approves exactly that call, and answers the run's result. */
  const approved = async (client: SessionClient, session: string, content: string) => {
    const turn = await client.sendMessage(session, { content });
    expect(turn.status).toBe("waiting");
    const id = String(turn.stop_reason?.approval_ids?.[0]);
    const { accepted } = await client.answerApproval(id, { decision: "allow", scope: "once" });
    return results(await client.waitTurn(accepted)).at(-1);
  };

  it("writes files through the gate with the tool's capability, as the mode decides", async () => {
    const bea = await as("bea");
    const s = await bea.startSession({ project });
    const note = (n: string) =>
      call("proj__note", { path: `/${project}/notes/${n}.md`, text: `noted ${n}` });
    // In `default`, the call asks, and the change the tool then makes asks too: it is refused.
    const refused = await approved(bea, s.id, note("n0"));
    expect(refused).toMatchObject({ isError: true });
    expect(String(refused?.output)).toMatch(/EACCES: the mode asks before this/);
    await bea.setMode({ mode: "acceptEdits" });
    try {
      const result = await approved(bea, s.id, note("n1"));
      expect(result).toMatchObject({ isError: false });
      expect(JSON.parse(String(result?.output)).listed).toEqual(["n1.md"]);
      const read = await bea.sendMessage(s.id, {
        content: call("read", { path: `/${project}/notes/n1.md` }),
      });
      expect(outputOf(read)).toContain("noted n1");
    } finally {
      await bea.setMode({ mode: "default" });
    }
  });

  it("generates OpenCode-style tools' documents, and runs them", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project });
    const shout = (await listed(ann, s.id)).find((x) => x.name === "oc__shout");
    expect(shout?.inputSchema).toMatchObject({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    });
    // Without an action in its document, an OpenCode-style tool is a write tool: it asks.
    const result = await approved(ann, s.id, call("oc__shout", { text: "hello" }));
    expect(result).toMatchObject({ isError: false, output: "HELLO!" });
  });

  it("does not load plugins whose scripts and operations don't match, or that fail the acceptance check", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project });
    const names = (await listed(ann, s.id)).map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(["proj__count_words", "calc__add"]));
    expect(names.filter((n) => n.startsWith("odd__") || n.startsWith("sly__"))).toEqual([]);
  });

  it("answers a thrown error as an error result, with the tool's log", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project });
    const turn = await ann.sendMessage(s.id, { content: call("proj__boom", {}) });
    expect(results(turn)).toEqual([expect.objectContaining({ isError: true })]);
    expect(outputOf(turn)).toContain("the boom tool failed");
    expect(outputOf(turn)).toContain("about to fail");
  });

  it("records Python scripts, which answer ENOSYS", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project });
    const turn = await ann.sendMessage(s.id, { content: call("proj__py_sum", { a: 1 }) });
    expect(results(turn)).toEqual([expect.objectContaining({ isError: true })]);
    expect(outputOf(turn)).toMatch(/^ENOSYS/);
  });

  it("keeps a tool's private database across its calls", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project });
    await ann.sendMessage(s.id, { content: call("proj__remember", { term: "alpha" }) });
    const turn = await ann.sendMessage(s.id, { content: call("proj__remember", { term: "beta" }) });
    expect(JSON.parse(outputOf(turn))).toEqual([{ term: "alpha" }, { term: "beta" }]);
  });

  it("ends a run at its timeout, and tells the script through its signal", async () => {
    const cy = await as("cy");
    const s = await cy.startSession({ project });
    const started = Date.now();
    const turn = await cy.sendMessage(s.id, { content: call("proj__spin", {}) });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(results(turn)).toEqual([expect.objectContaining({ isError: true })]);
    expect(outputOf(turn)).toMatch(/ETIMEDOUT/);
  });

  it("meters the isolate's time, and ends the run when a limit refuses more", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project: `meter-${t}` });
    const quick = await ann.sendMessage(s.id, {
      content: call("proj__count_words", { path: `/meter-${t}/doc.txt` }),
    });
    expect(results(quick)).toEqual([expect.objectContaining({ isError: false })]);
    const charged = (await usageRecords(deployment)).filter(
      (r) => r.project === `meter-${t}` && r.meter === "executor_cpu_ms:isolate",
    );
    expect(charged.length).toBeGreaterThan(0);
    // The project allows 600 ms a day: a run that would go on is ended by the limit, before its
    // own timeout.
    const turn = await ann.sendMessage(s.id, { content: call("proj__spin", {}) });
    expect(results(turn)).toEqual([expect.objectContaining({ isError: true })]);
    expect(outputOf(turn)).toMatch(/ELIMIT/);
    const after = await ann.sendMessage(s.id, {
      content: call("proj__count_words", { path: `/meter-${t}/doc.txt` }),
    });
    expect(outputOf(after)).toMatch(/ELIMIT/);
  });

  it("holds an approved call to the session's own limit on isolate time", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({
      project,
      limits: [{ meter: "executor_cpu_ms:isolate", value: 1, period: "total" }],
    });
    // The asking tool's approved run counts at the session level...
    const first = await approved(ann, s.id, call("oc__shout", { text: "once" }));
    expect(first).toMatchObject({ isError: false, output: "ONCE!" });
    // ...so the next call is refused before it runs (or asks).
    const second = await ann.sendMessage(s.id, { content: call("oc__shout", { text: "twice" }) });
    expect(results(second)).toEqual([expect.objectContaining({ isError: true })]);
    expect(outputOf(second)).toMatch(/ELIMIT/);
  });

  it("runs a deployment catalog bundle only once it is approved by hash", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project });
    const turn = await ann.sendMessage(s.id, { content: call("calc__add", { a: 1, b: 2 }) });
    expect(results(turn)).toEqual([expect.objectContaining({ isError: true })]);
    expect(outputOf(turn)).toMatch(/EACCES: .*calc.*[0-9a-f]{64}.*not approved/);
  });
});

describe("an approved deployment catalog bundle", () => {
  let approved: Deployment;
  beforeAll(async () => {
    // The refusal names the plugin bundle's hash, which the operator approves.
    const token = await login(deployment, "ann-rest");
    const ann = await restClient(deployment, token);
    const s = await ann.startSession({ project: "tools-rest" });
    const refused = outputOf(await ann.sendMessage(s.id, { content: call("calc__add", {}) }));
    const hash = /[0-9a-f]{64}/.exec(refused)?.[0] as string;
    approved = await startDeployment(HOST, vars(model, { APPROVED_BUNDLES: hash }));
    await seed(approved, ADMIN_KEY, {
      "/calc-p/.system/access": JSON.stringify({ "ann-rest": "owner" }),
    });
  }, 120_000);
  afterAll(async () => {
    await approved?.close();
  });

  it("runs, with the network off", async () => {
    const ann = await restClient(approved, await login(approved, "ann-rest"));
    const s = await ann.startSession({ project: "calc-p" });
    const sum = await ann.sendMessage(s.id, { content: call("calc__add", { a: 1, b: 2 }) });
    expect(JSON.parse(outputOf(sum))).toEqual({ sum: 3 });
    const net = await ann.sendMessage(s.id, { content: call("calc__net", {}) });
    expect(outputOf(net)).toMatch(/^no network/);
  });
});
