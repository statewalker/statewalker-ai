// Telemetry without content (statewalker/statewalker-root#182, decision #158): the deployment
// exports OpenTelemetry traces, metrics and structured logs over OTLP to the operator's collector,
// one trace per turn with spans for model requests, tool calls, executor runs, memory-tool calls
// and approval waits, and carrying ids, sizes, timings and outcomes only. The threat-table check
// runs a turn with a known secret, file content, memory entry and message (and a user whose id is
// an email) and finds none of them in anything exported. Run against the harness's own
// deployment (ai-host-do) on CellB Node in-process, with the scripted model, over REST and RPC.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type CollectedSpan,
  type Deployment,
  type FakeCollector,
  type FakeModel,
  type FakeRest,
  fakeCollector,
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
const TOOLS = "dev.cellb.harness/tools";

// What must never leave in telemetry: each is unique, so a substring match finds any copy.
const SECRET = "secret-value-q8z3k1";
const FILE_TEXT = "file-content-w4v7p2 the plans";
const MEMORY_TEXT = "memory-entry-m5n9r6 remembered";
const MESSAGE_TEXT = "message-text-h2j6t8 from the user";
const BOOM = "EBOOM_TARGET_Z7X4";
const EMAIL = (t: string) => `eve.${t}@example.com`;

const op = (id: string, props: Record<string, unknown>) => ({
  post: {
    operationId: id,
    summary: `the ${id} tool`,
    "x-dev.cellb.harness": { action: "read" },
    requestBody: {
      content: { "application/json": { schema: { type: "object", properties: props } } },
    },
  },
});

/** A project plugin whose native tool reads a file and answers its content. */
const projectPlugin = (root: string) => ({
  [`${root}/proj/plugin.json`]: JSON.stringify({ $schema: AP, name: "proj" }),
  [`${root}/proj/${TOOLS}/openapi.json`]: JSON.stringify({
    openapi: "3.1.0",
    info: { title: "proj", version: "1" },
    paths: {
      "/peek": op("peek", { path: { type: "string" } }),
      "/scribble": op("scribble", { path: { type: "string" } }),
      "/boom": op("boom", {}),
    },
  }),
  [`${root}/proj/${TOOLS}/peek.js`]: `
    export default async function execute(input, ctx) {
      let text = "";
      for await (const chunk of ctx.files.read(input.path)) text += new TextDecoder().decode(chunk);
      return text;
    }`,
  // Fails with a message whose first word looks like an error code: it is free text all the same.
  [`${root}/proj/${TOOLS}/boom.js`]: `
    export default async function execute() {
      throw new Error("${BOOM} the quarterly target");
    }`,
  // Says it only reads, and writes: the gate asks about the write, which a tool cannot wait for.
  [`${root}/proj/${TOOLS}/scribble.js`]: `
    export default async function execute(input, ctx) {
      await ctx.files.write(input.path, [new TextEncoder().encode("x")]);
      return "written";
    }`,
});

/** The deployment's catalog: a REST tool sending the user's secret (`/echo` answers it back). */
const catalog = (base: string) => ({
  "/fixture/plugin.json": JSON.stringify({ $schema: AP, name: "fixture" }),
  "/fixture/dev.cellb.harness/agents/default.md":
    "---\nname: default\ntools: [fixture/*, proj/*, read, write, memory]\n---\nYou help.\n",
  "/fixture/dev.cellb.harness/tools/rest/api.json": JSON.stringify({
    openapi: "3.1.0",
    info: { title: "fixture", version: "1" },
    servers: [{ url: base }],
    components: {
      securitySchemes: {
        API_TOKEN: {
          type: "http",
          scheme: "bearer",
          "x-dev.cellb.harness": { secret: "API_TOKEN" },
        },
      },
    },
    paths: { "/echo": { get: { operationId: "echo", security: [{ API_TOKEN: [] }] } } },
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

let model: FakeModel;
let rest: FakeRest;
let collector: FakeCollector;
let deployment: Deployment;

beforeAll(async () => {
  model = await fakeModel();
  rest = await fakeRest();
  collector = await fakeCollector();
  deployment = await startDeployment(HOST, {
    MODELS: model.deploymentModels(),
    DEV_LOGIN: "true",
    ADMIN_KEY,
    SECRETS_KEY: "conformance-secrets-key",
    CATALOG: JSON.stringify(catalog(rest.url)),
    DEFAULT_AGENT: "fixture/default",
    // Every gate operation traced (the default samples 1%), exported every 20 ms.
    TELEMETRY: JSON.stringify({
      exporter: "otlp",
      endpoint: collector.url,
      headers_secret: "OTLP_HEADERS",
      gate_sample: 1,
      flush_ms: 20,
    }),
    OTLP_HEADERS: JSON.stringify({ authorization: "Bearer collector-key" }),
  });
  const files: Record<string, string> = {};
  for (const t of ["rest", "rpc"]) {
    Object.assign(files, projectPlugin(`/tel-${t}/.system/plugins`));
    files[`/tel-${t}/.system/access`] = JSON.stringify({ [EMAIL(t)]: "owner" });
    files[`/tel-${t}/plans.md`] = FILE_TEXT;
  }
  await seed(deployment, ADMIN_KEY, files);
}, 120_000);
afterAll(async () => {
  for (const s of sockets) s.close();
  await deployment?.close();
  await model?.close();
  await rest?.close();
  await collector?.close();
});

const call = (tool: string, args: unknown) => `CALL ${tool} ${JSON.stringify(args)}`;
const inTrace = (turn: Turn) => (s: CollectedSpan) => s.attributes["turn.id"] === turn.id;

describe.each(transports)("telemetry over %s", (name, connect) => {
  const t = name.toLowerCase();
  const project = `tel-${t}`;
  const as = async () => connect(deployment, await login(deployment, EMAIL(t)));

  it.skipIf(RUNTIME === "browser")(
    "exports no secret, file content, memory entry, message or email from a turn that held them all",
    async () => {
      const eve = await as();
      await eve.setSecret({
        level: "user",
        name: "API_TOKEN",
        value: SECRET,
        bindings: { plugins: ["fixture"], hosts: ["127.0.0.1"] },
      });
      const session = await eve.startSession({ project });
      const said = await eve.sendMessage(session.id, { content: MESSAGE_TEXT });
      expect(said.status).toBe("completed");
      // One answer of several tool calls: read the file, peek at it in an isolate, call the REST
      // tool that sends the secret (its answer echoes it back), and remember an entry.
      const turn = await eve.sendMessage(session.id, {
        content: [
          call("read", { path: `/${project}/plans.md` }),
          call("proj__peek", { path: `/${project}/plans.md` }),
          call("fixture__echo", {}),
          call("proj__boom", {}),
          call("memory", {
            kind: "project",
            actions: [{ op: "add", body: MEMORY_TEXT, title: "kept" }],
          }),
        ].join("\n"),
      });
      expect(turn.status).toBe("completed");
      const results = turn.items.filter((i) => i.kind === "tool_result") as {
        output?: string;
        isError?: boolean;
      }[];
      // The turn did hold every one of them.
      expect(results.map((r) => r.isError)).toEqual([false, false, false, true, false]);
      expect(String(results[3]?.output)).toContain(BOOM);
      expect(String(results[0]?.output)).toContain(FILE_TEXT);
      expect(String(results[1]?.output)).toContain(FILE_TEXT);
      // The secret went out in the tool's request (the gateway masks it in the answer).
      expect(rest.requests.some((r) => r.headers.authorization === `Bearer ${SECRET}`)).toBe(true);
      const memory = await eve.listMemory({ project, kind: "project" });
      expect(memory.entries.map((e) => e.body)).toContain(MEMORY_TEXT);

      await collector.until(() =>
        collector.spans().some((s) => s.name === "turn" && inTrace(turn)(s)),
      );
      // A moment for the other components' batches.
      await collector.until(() =>
        ["model.request", "tool.call", "memory.call", "executor.run"].every((n) =>
          collector.spans().some((s) => s.name === n && inTrace(turn)(s)),
        ),
      );
      const exported = collector.text();
      for (const value of [
        SECRET,
        FILE_TEXT,
        MEMORY_TEXT,
        MESSAGE_TEXT,
        EMAIL(t),
        "plans.md",
        BOOM,
      ])
        expect(exported).not.toContain(value);
      expect(exported).not.toContain("w4v7p2");
      expect(exported).not.toContain("m5n9r6");
      expect(exported).not.toContain("h2j6t8");
      expect(exported).not.toContain("q8z3k1");
      // Sent with the headers from the runtime secret the configuration names.
      expect(collector.bodies[0]?.headers.authorization).toBe("Bearer collector-key");
    },
  );

  it.skipIf(RUNTIME === "browser")(
    "traces a turn: one trace, with spans for model requests, tool calls, executor runs and memory calls",
    async () => {
      const eve = await as();
      const session = await eve.startSession({ project });
      const turn = await eve.sendMessage(session.id, {
        content: [
          call("read", { path: `/${project}/plans.md` }),
          call("proj__peek", { path: `/${project}/plans.md` }),
          call("memory", { kind: "project", actions: [{ op: "search", query: "kept" }] }),
        ].join("\n"),
      });
      expect(turn.status).toBe("completed");
      const spansOf = () => collector.spans().filter(inTrace(turn));
      await collector.until(() =>
        ["turn", "model.request", "tool.call", "memory.call", "executor.run"].every((n) =>
          spansOf().some((s) => s.name === n),
        ),
      );
      const spans = spansOf();
      const root = spans.find((s) => s.name === "turn") as CollectedSpan;
      expect(root.parentSpanId).toBeUndefined();
      expect(root).toMatchObject({
        status: "ok",
        attributes: {
          "session.id": session.id,
          "project.id": project,
          "agent.id": "fixture/default",
          "turn.status": "completed",
          stop_reason: "end_turn",
          "model.id": "scripted/default",
        },
      });
      // The user's id is an email here: it is left out.
      expect(root.attributes["user.id"]).toBeUndefined();
      // Every span of the turn, in whichever DO it was made, is in its trace under its root.
      for (const s of spans) expect(s.traceId).toBe(root.traceId);
      for (const s of spans.filter((s) => s !== root)) expect(s.parentSpanId).toBe(root.spanId);
      const models = spans.filter((s) => s.name === "model.request");
      expect(models.length).toBe(2);
      expect(models[0]?.attributes).toMatchObject({
        "model.id": "scripted/default",
        "provider.id": "scripted",
        // The scripted model's 12 prompt tokens, 4 of them cached.
        "tokens.input": 8,
        "tokens.output": 3,
        "tokens.cached": 4,
        attempts: 1,
        stop_reason: "toolUse",
      });
      expect(
        spans
          .filter((s) => s.name === "tool.call")
          .map((s) => [s.attributes["tool.name"], s.attributes["tool.kind"]]),
      ).toEqual(
        expect.arrayContaining([
          ["read", "files"],
          ["proj__peek", "native"],
        ]),
      );
      expect(spans.find((s) => s.name === "memory.call")?.attributes).toMatchObject({
        "tool.name": "memory",
        "tool.kind": "harness",
      });
      expect(spans.find((s) => s.name === "executor.run")?.attributes).toMatchObject({
        "executor.kind": "isolate",
        "tool.name": "proj__peek",
      });
      expect(spans.find((s) => s.name === "executor.run")?.resource.component).toBe("workspace");
    },
  );

  it.skipIf(RUNTIME === "browser")(
    "traces the wait on an approval, and a refused tool call's denied permission and code",
    async () => {
      const eve = await as();
      await eve.setMode({ mode: "default" });
      const session = await eve.startSession({ project });
      const asked = await eve.sendMessage(session.id, {
        content: call("write", { path: `/${project}/new.md`, content: FILE_TEXT }),
      });
      expect(asked.status).toBe("waiting");
      const approval = asked.stop_reason?.approval_ids?.[0] as string;
      const { accepted } = await eve.answerApproval(approval, { decision: "deny", scope: "once" });
      const answer = await eve.waitTurn(accepted);
      await collector.until(() =>
        collector
          .spans()
          .some((s) => s.name === "approval.wait" && s.attributes["turn.id"] === answer.id),
      );
      const wait = collector
        .spans()
        .find((s) => s.name === "approval.wait" && s.attributes["turn.id"] === answer.id);
      expect(wait?.attributes).toMatchObject({
        "approval.id": approval,
        "approval.decision": "deny",
        "turn.origin": asked.id,
      });
      expect(collector.logs().map((l) => l.event)).toEqual(
        expect.arrayContaining(["approval.requested", "approval.answered"]),
      );
      expect(collector.text()).not.toContain("new.md");
      // A tool call refused at the gate: its span fails with the code, naming the tool's
      // permission, and counts as a denial.
      const refused = await eve.sendMessage(session.id, {
        content: call("proj__scribble", { path: `/${project}/scribbled.md` }),
      });
      await collector.until(() =>
        collector
          .spans()
          .some((s) => s.name === "tool.call" && s.attributes["turn.id"] === refused.id),
      );
      expect(
        collector
          .spans()
          .find((s) => s.name === "tool.call" && s.attributes["turn.id"] === refused.id),
      ).toMatchObject({
        status: "error",
        attributes: {
          "error.code": "EACCES",
          permission: "tools.use:proj/scribble",
          "tool.kind": "native",
        },
      });
      await collector.until(() =>
        collector
          .metrics()
          .some((m) => m.name === "harness.denials" && m.attributes.span === "tool.call"),
      );
    },
  );
});

describe("metrics and logs", () => {
  it.skipIf(RUNTIME === "browser")(
    "counts the meters, measures latencies and queue waits, and logs lifecycle events",
    async () => {
      await collector.until(() =>
        ["harness.usage", "harness.span.duration", "harness.turn.queue_wait"].every((n) =>
          collector.metrics().some((m) => m.name === n),
        ),
      );
      const metrics = collector.metrics();
      const usage = (meter: string) =>
        metrics
          .filter((m) => m.name === "harness.usage" && m.attributes.meter === meter)
          .reduce((n, m) => n + m.value, 0);
      expect(usage("turns")).toBeGreaterThan(0);
      expect(usage("tool_calls")).toBeGreaterThan(0);
      expect(usage("model_tokens")).toBeGreaterThan(0);
      expect(
        metrics.some(
          (m) => m.name === "harness.span.duration" && m.attributes.span === "model.request",
        ),
      ).toBe(true);
      expect(
        metrics.some(
          (m) => m.name === "harness.span.duration" && m.attributes.span === "gate.files",
        ),
      ).toBe(true);
      const events = collector.logs().map((l) => l.event);
      expect(events).toEqual(
        expect.arrayContaining(["turn.queued", "turn.started", "turn.completed"]),
      );
      // Ids and outcomes only: no metric or log carries a session's words.
      expect(collector.text()).not.toContain(MESSAGE_TEXT);
    },
  );
});
