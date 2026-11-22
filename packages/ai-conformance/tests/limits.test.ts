// Meters, limits and usage records (statewalker/statewalker-root#179, decision #158): limits at the
// deployment (the LIMITS var), workspace (`/.system/limits`, which also holds member limits),
// project (`<project>/.system/limits`), user (their profile's `/limits`, for their own keys) and
// session (the start request's `limits`) levels; the tightest applies, usage is charged to every
// level on its path, and each meter denies its own way. Run against the harness's own deployment
// (ai-host-do) on CellB Node in-process, with the scripted model, over REST and RPC.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Deployment,
  exportUsage,
  type FakeModel,
  type FakeRest,
  fakeModel,
  fakeRest,
  login,
  restClient,
  restDb,
  restFiles,
  rpcClient,
  rpcDb,
  rpcFiles,
  type SessionClient,
  seed,
  seedProfiles,
  startDeployment,
} from "../src/index.js";

const HOST = new URL("../../ai-host-do/", import.meta.url);
const ADMIN_KEY = "conformance-admin-key";
const OPERATOR_KEY = "conformance-operator-key";

const TRANSPORTS = ["rest", "rpc"];

const limits = (...list: Record<string, unknown>[]) => JSON.stringify(list);

/** Each transport's own projects and users, so scenarios don't share counters. */
function projectFiles(t: string): Record<string, string> {
  const owner = (...users: string[]) =>
    JSON.stringify(Object.fromEntries(users.map((u) => [`${u}-${t}`, "owner"])));
  return {
    [`/turns-${t}/.system/access`]: owner("ann"),
    [`/turns-${t}/.system/limits`]: limits({
      meter: "turns",
      level: "project",
      value: 2,
      period: "day",
    }),
    [`/sessions-${t}/.system/access`]: owner("ann", "bob", "sam"),
    [`/tools-${t}/.system/access`]: owner("ann"),
    [`/tools-${t}/readme.md`]: "README",
    [`/parallel-${t}/.system/access`]: owner("ann"),
    [`/parallel-${t}/.system/limits`]: limits({
      meter: "model_spend",
      level: "project",
      value: 25,
      period: "month",
    }),
    [`/warn-${t}/.system/access`]: owner("ann"),
    [`/warn-${t}/.system/limits`]: limits({
      meter: "turns",
      level: "project",
      value: 4,
      period: "day",
      warn_at: 0.5,
    }),
    [`/free-${t}/.system/access`]: owner("ann", "kim"),
    [`/store-${t}/.system/access`]: owner("ann"),
    [`/store-${t}/.system/limits`]: limits({
      meter: "storage_bytes",
      level: "project",
      value: 100,
    }),
    [`/store-${t}/seeded.txt`]: "x".repeat(20),
    [`/dbfull-${t}/.system/access`]: owner("ann"),
    [`/dbfull-${t}/.system/databases`]: JSON.stringify({ notes: {} }),
    [`/dbfull-${t}/.system/limits`]: limits({ meter: "storage_bytes", level: "project", value: 0 }),
    [`/dbroom-${t}/.system/access`]: owner("ann"),
    [`/dbroom-${t}/.system/databases`]: JSON.stringify({ notes: {} }),
    [`/net-${t}/.system/access`]: owner("ann"),
    [`/net-${t}/.system/limits`]: limits({
      meter: "outbound_requests",
      level: "project",
      value: 1,
      period: "day",
    }),
    [`/spend-${t}/.system/access`]: owner("ann"),
    [`/spend-${t}/.system/limits`]: limits({
      meter: "model_spend",
      level: "project",
      value: 12,
      period: "month",
    }),
  };
}

const FILES: Record<string, string> = {
  // Member limits live in the workspace's file: bob may hold one active session at a time.
  "/.system/limits": limits(
    ...TRANSPORTS.map((t) => ({
      meter: "sessions",
      level: "member",
      target: `bob-${t}`,
      value: 1,
    })),
    // sam may hold one stream at a time.
    ...TRANSPORTS.map((t) => ({ meter: "streams", level: "member", target: `sam-${t}`, value: 1 })),
  ),
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

/** The workspace's usage records (test-only admin route). */
async function usageRecords(workspace: string): Promise<Record<string, unknown>[]> {
  return (await exportUsage(deployment, OPERATOR_KEY, { workspace })) as never;
}

let model: FakeModel;
let rest: FakeRest;
/** A deployment whose LIMITS hold each workspace to one turn a day. */
let ceilinged: Deployment;
let deployment: Deployment;

beforeAll(async () => {
  model = await fakeModel();
  rest = await fakeRest();
  deployment = await startDeployment(HOST, {
    // One REST tool, `fixture__call`, imported from an OpenAPI spec (#129).
    CATALOG: JSON.stringify({
      "/fixture/plugin.json": JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "fixture",
      }),
      "/fixture/dev.cellb.harness/agents/default.md":
        "---\nname: default\ntools: [fixture/*]\n---\n",
      "/fixture/dev.cellb.harness/tools/rest/api.json": JSON.stringify({
        openapi: "3.1.0",
        info: { title: "fixture", version: "1" },
        servers: [{ url: rest.url }],
        paths: { "/call": { get: { operationId: "call" } } },
      }),
    }),
    DEFAULT_AGENT: "fixture/default",
    DEV_LOGIN: "true",
    ADMIN_KEY,
    OPERATOR_KEY,
    SECRETS_KEY: "conformance-secrets-key",
    USER_PROVIDER_HOSTS: "127.0.0.1",
    MODELS: model.deploymentModels({
      models: [
        { id: "scripted/default", alias: "default" },
        // One currency unit per output token, at most 10 of them: a request's worst case is 10.
        { id: "scripted/priced", maxTokens: 10, cost: { input: 0, output: 1_000_000 } },
      ],
    }),
  });
  await seed(deployment, ADMIN_KEY, FILES);
  ceilinged = await startDeployment(HOST, {
    DEV_LOGIN: "true",
    ADMIN_KEY,
    WORKSPACES: TRANSPORTS.flatMap((t) => [`${t}1`, `${t}2`]).join(","),
    MODELS: model.deploymentModels(),
    LIMITS: limits({ meter: "turns", level: "deployment", value: 1, period: "day" }),
  });
  for (const t of TRANSPORTS)
    for (const workspace of [`${t}1`, `${t}2`])
      await seed(
        ceilinged,
        ADMIN_KEY,
        { [`/ceiling-${t}/.system/access`]: JSON.stringify({ [`ann-${t}`]: "owner" }) },
        workspace,
      );
  // Each user's own limits are in their profile: they cap spend on their own keys.
  await seedProfiles(
    deployment,
    ADMIN_KEY,
    Object.fromEntries(
      TRANSPORTS.map((t) => [
        `/profiles/kim-${t}/limits`,
        limits({ meter: "model_spend", level: "user", value: 12, period: "month" }),
      ]),
    ),
  );
}, 120_000);
afterAll(async () => {
  for (const s of sockets) s.close();
  await deployment?.close();
  await ceilinged?.close();
  await model?.close();
  await rest?.close();
});

describe.each(transports)("limits over %s", (name, connect) => {
  const t = name.toLowerCase();
  const u = (user: string) => `${user}-${t}`;
  const as = async (user: string) => connect(deployment, await login(deployment, u(user)));

  it("answers 429 to a turn over the project's limit on turns", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project: `turns-${t}` });
    for (let i = 0; i < 2; i++)
      expect(await ann.sendMessage(s.id, { content: "hello" })).toMatchObject({
        status: "completed",
      });
    await expect(ann.postMessage(s.id, { content: "hello" })).rejects.toMatchObject({
      status: 429,
      message: expect.stringContaining("turns"),
    });
    // REST says when the day's window resets.
    const res = await deployment.fetch(`/v1/sessions/${s.id}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await login(deployment, u("ann"))}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ content: "hello" }),
    });
    expect(res.status).toBe(429);
    const retry = Number(res.headers.get("retry-after"));
    expect(retry > 0 && retry <= 86_400).toBe(true);
  });

  it("answers 429 to a session start over the member's limit on active sessions, until one ends", async () => {
    const bob = await as("bob");
    const first = await bob.startSession({ project: `sessions-${t}` });
    await expect(bob.startSession({ project: `sessions-${t}` })).rejects.toMatchObject({
      status: 429,
      message: expect.stringContaining("sessions"),
    });
    // Another member is not held by bob's limit.
    const ann = await as("ann");
    await ann.startSession({ project: `sessions-${t}` });
    await bob.archiveSession(first.id);
    const second = await bob.startSession({ project: `sessions-${t}` });
    await bob.deleteSession(second.id);
    await bob.startSession({ project: `sessions-${t}` });
  });

  it("refuses a tool call over the session's limit on tool calls, and the agent carries on", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({
      project: `tools-${t}`,
      limits: [{ meter: "tool_calls", value: 1, period: "total" }],
    });
    const read = `CALL read ${JSON.stringify({ path: "readme.md" })}`;
    const first = await ann.sendMessage(s.id, { content: read });
    expect(first.items.find((i) => i.kind === "tool_result")).toMatchObject({ isError: false });
    const second = await ann.sendMessage(s.id, { content: read });
    expect(second.status).toBe("completed");
    const refused = second.items.find((i) => i.kind === "tool_result");
    expect(refused).toMatchObject({ isError: true, output: expect.stringContaining("tool_calls") });
    // The model was told, and answered.
    expect(second.items.at(-1)).toMatchObject({ kind: "message", role: "assistant" });
    // A session limit is the session's own: a new session calls tools again.
    const other = await ann.startSession({ project: `tools-${t}` });
    const again = await ann.sendMessage(other.id, { content: read });
    expect(again.items.find((i) => i.kind === "tool_result")).toMatchObject({ isError: false });
  });

  it("ends a turn incomplete with stop_reason budget, naming the limit, when model spend would cross it", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project: `spend-${t}`, model: "scripted/priced" });
    // The worst case (10) fits; the request really costs 3.
    expect(await ann.sendMessage(s.id, { content: "hello" })).toMatchObject({
      status: "completed",
    });
    const asked = model.requests.length;
    // 3 used and a worst case of 10 would cross 12: refused before the model is asked.
    const turn = await ann.sendMessage(s.id, { content: "hello" });
    expect(turn).toMatchObject({
      status: "incomplete",
      stop_reason: {
        type: "budget",
        limit: { meter: "model_spend", level: "project", target: `spend-${t}`, value: 12 },
      },
    });
    expect(model.requests.length).toBe(asked);
  });

  it("reserves each request's worst case against every level, so parallel sessions never overshoot", async () => {
    const ann = await as("ann");
    const sessions = await Promise.all(
      [0, 1, 2].map(() => ann.startSession({ project: `parallel-${t}`, model: "scripted/priced" })),
    );
    // Two requests are held at the model: their worst cases (10 each) are reserved.
    const held = await Promise.all(
      [0, 1].map((i) =>
        ann.postMessage(String(sessions[i]?.id), { content: `HOLD par-${t}-${i}` }),
      ),
    );
    await Promise.all([0, 1].map((i) => model.held(`par-${t}-${i}`)));
    // A third would make 30 of 25 if all of them spent their worst: refused.
    const third = await ann.sendMessage(String(sessions[2]?.id), { content: "hello" });
    expect(third).toMatchObject({ status: "incomplete", stop_reason: { type: "budget" } });
    for (const i of [0, 1]) model.release(`par-${t}-${i}`);
    for (const accepted of held)
      expect(await ann.waitTurn(accepted)).toMatchObject({ status: "completed" });
    // Settled to the real cost (3 each): there is room again.
    expect(await ann.sendMessage(String(sessions[2]?.id), { content: "hello" })).toMatchObject({
      status: "completed",
    });
  });

  it("leaves an item and an event once usage crosses a limit's warn_at", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project: `warn-${t}` });
    const first = await ann.sendMessage(s.id, { content: "hello" });
    expect(first.items.some((i) => i.kind === "limit_warning")).toBe(false);
    const second = await ann.sendMessage(s.id, { content: "hello" });
    expect(second.items.filter((i) => i.kind === "limit_warning")).toEqual([
      expect.objectContaining({
        warning: expect.objectContaining({
          meter: "turns",
          level: "project",
          target: `warn-${t}`,
          used: 2,
          value: 4,
        }),
      }),
    ]);
    const { events } = await ann.readEvents(s.id);
    expect(events.filter((e) => e.type === "limit.warning")).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ meter: "turns", used: 2 }) }),
    ]);
    // Once per window: the third turn warns no more.
    const third = await ann.sendMessage(s.id, { content: "hello" });
    expect(third.items.some((i) => i.kind === "limit_warning")).toBe(false);
  });

  it("holds a session to its own limit on model spend, counted in its own DO", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({
      project: `free-${t}`,
      model: "scripted/priced",
      limits: [{ meter: "model_spend", value: 12, period: "total" }],
    });
    expect(await ann.sendMessage(s.id, { content: "hello" })).toMatchObject({
      status: "completed",
    });
    expect(await ann.sendMessage(s.id, { content: "hello" })).toMatchObject({
      status: "incomplete",
      stop_reason: { type: "budget", limit: { level: "session", target: s.id, value: 12 } },
    });
    // Another session of the same user in the same project is not held by it.
    const other = await ann.startSession({ project: `free-${t}`, model: "scripted/priced" });
    expect(await ann.sendMessage(other.id, { content: "hello" })).toMatchObject({
      status: "completed",
    });
  });

  it("charges spend on the user's own key to the user's limits, not the workspace's", async () => {
    const kim = await as("kim");
    await kim.setSecret({
      level: "user",
      name: "KIM_KEY",
      value: "kim-model-key",
      bindings: { plugins: ["model-gateway"], hosts: ["127.0.0.1"] },
    });
    await kim.setModelConfig({
      providers: [{ id: "kims", api: "openai-completions", baseUrl: model.url, secret: "KIM_KEY" }],
      models: [{ id: "kims/own", maxTokens: 10, cost: { input: 0, output: 1_000_000 } }],
    });
    const s = await kim.startSession({ project: `free-${t}`, model: "kims/own" });
    expect(await kim.sendMessage(s.id, { content: "hello" })).toMatchObject({
      status: "completed",
    });
    expect(await kim.sendMessage(s.id, { content: "hello" })).toMatchObject({
      status: "incomplete",
      stop_reason: { type: "budget", limit: { level: "user", target: `kim-${t}`, value: 12 } },
    });
    // The workspace's own models are not the user's keys: they still run for kim.
    const priced = await kim.startSession({ project: `free-${t}`, model: "scripted/priced" });
    expect(await kim.sendMessage(priced.id, { content: "hello" })).toMatchObject({
      status: "completed",
    });
    // Own-key spend is recorded with the user, never in the workspace's usage records.
    const records = await usageRecords("default");
    expect(records.some((r) => r.session === s.id && r.meter === "model_spend")).toBe(false);
  });

  it("asks at session level: an approval raises the limit by one increment", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({
      project: `tools-${t}`,
      limits: [{ meter: "tool_calls", value: 1, period: "total", on_exceed: "ask", increment: 1 }],
    });
    const read = `CALL read ${JSON.stringify({ path: "readme.md" })}`;
    await ann.sendMessage(s.id, { content: read });
    const asked = await ann.sendMessage(s.id, { content: read });
    expect(asked).toMatchObject({ status: "waiting", stop_reason: { type: "approval" } });
    const id = String(asked.stop_reason?.approval_ids?.[0]);
    const { approvals } = await ann.listApprovals();
    expect(approvals.find((a) => a.id === id)).toMatchObject({
      session: s.id,
      action: { method: "limit" },
      permission: "limits.raise:tool_calls",
      status: "pending",
    });
    const { accepted } = await ann.answerApproval(id, { decision: "allow", scope: "once" });
    const raised = await ann.waitTurn(accepted);
    expect(raised).toMatchObject({ status: "completed" });
    // The agent continues the turn once the limit is raised (statewalker/statewalker-root#214).
    expect(raised.items.map((i) => i.kind)).toEqual(["tool_result", "message"]);
    // One increment: one more tool call, then it asks again.
    const third = await ann.sendMessage(s.id, { content: read });
    expect(third.items.find((i) => i.kind === "tool_result")).toMatchObject({ isError: false });
    expect(await ann.sendMessage(s.id, { content: read })).toMatchObject({ status: "waiting" });
  });

  it("denies what a limit would ask about when the session is unattended", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({
      project: `tools-${t}`,
      unattended: true,
      limits: [{ meter: "tool_calls", value: 1, period: "total", on_exceed: "ask" }],
    });
    const read = `CALL read ${JSON.stringify({ path: "readme.md" })}`;
    await ann.sendMessage(s.id, { content: read });
    const second = await ann.sendMessage(s.id, { content: read });
    expect(second.status).toBe("completed");
    expect(second.items.find((i) => i.kind === "tool_result")).toMatchObject({
      isError: true,
      output: expect.stringContaining("unattended"),
    });
  });

  it("refuses an outbound request over the session's own limit, and the agent carries on", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({
      project: `free-${t}`,
      limits: [{ meter: "outbound_requests", value: 1, period: "total" }],
    });
    const first = await ann.sendMessage(s.id, { content: "CALL fixture__call {}" });
    expect(first.items.find((i) => i.kind === "tool_result")).toMatchObject({ isError: false });
    const calls = rest.requests.length;
    const second = await ann.sendMessage(s.id, { content: "CALL fixture__call {}" });
    expect(second.items.find((i) => i.kind === "tool_result")).toMatchObject({
      isError: true,
      output: expect.stringContaining("outbound_requests"),
    });
    expect(rest.requests.length).toBe(calls);
  });

  it("refuses a session limit on a meter the session level does not count", async () => {
    const ann = await as("ann");
    for (const meter of ["storage_bytes", "streams", "sessions", "outbound_bytes"])
      await expect(
        ann.startSession({ project: `free-${t}`, limits: [{ meter, value: 1, period: "total" }] }),
      ).rejects.toMatchObject({ status: 400, message: expect.stringContaining(meter) });
  });

  it("refuses an outbound request over the project's limit, and the agent carries on", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project: `net-${t}` });
    const first = await ann.sendMessage(s.id, { content: "CALL fixture__call {}" });
    expect(first.items.find((i) => i.kind === "tool_result")).toMatchObject({ isError: false });
    const calls = rest.requests.length;
    const second = await ann.sendMessage(s.id, { content: "CALL fixture__call {}" });
    expect(second.status).toBe("completed");
    expect(second.items.find((i) => i.kind === "tool_result")).toMatchObject({
      isError: true,
      output: expect.stringContaining("outbound_requests"),
    });
    expect(rest.requests.length).toBe(calls);
    // Requests and bytes are recorded, naming the session and the turn.
    const records = await usageRecords("default");
    expect(records.filter((r) => r.session === s.id && r.meter === "outbound_requests")).toEqual([
      expect.objectContaining({ amount: 1, turn: first.id, project: `net-${t}`, user: `ann-${t}` }),
    ]);
    expect(records.some((r) => r.session === s.id && r.meter === "outbound_bytes")).toBe(true);
  });

  it("fails file writes with ENOSPC over the project's storage limit, while reads and deletes work", async () => {
    const token = await login(deployment, u("ann"));
    const files = t === "rest" ? restFiles(deployment, token) : await rpcFiles(deployment, token);
    sockets.push(files);
    const bytes = (n: number) => [new TextEncoder().encode("y".repeat(n))];
    // 20 bytes were there already; 60 more fit in 100.
    await files.write(`/store-${t}/a.txt`, bytes(60));
    await expect(files.write(`/store-${t}/b.txt`, bytes(30))).rejects.toMatchObject({
      message: expect.stringContaining("ENOSPC"),
      ...(t === "rest" ? { status: 507 } : {}),
    });
    expect(await files.exists(`/store-${t}/b.txt`)).toBe(false);
    // Reading works, and so does deleting, which makes room again.
    let read = 0;
    for await (const chunk of files.read(`/store-${t}/a.txt`)) read += chunk.length;
    expect(read).toBe(60);
    expect(await files.remove(`/store-${t}/a.txt`)).toBe(true);
    await files.write(`/store-${t}/b.txt`, bytes(30));
    // Overwriting a file counts what it adds, not its whole size.
    await files.write(`/store-${t}/b.txt`, bytes(70));
  });

  it("fails database writes with ENOSPC over the storage limit, while queries work", async () => {
    const token = await login(deployment, u("ann"));
    const db = t === "rest" ? restDb(deployment, token) : await rpcDb(deployment, token);
    sockets.push(db);
    expect(await db.query(`dbfull-${t}`, "notes", "SELECT 1 AS one")).toEqual([{ one: 1 }]);
    await expect(db.exec(`dbfull-${t}`, "notes", "CREATE TABLE t (x)")).rejects.toMatchObject({
      message: expect.stringContaining("ENOSPC"),
    });
  });

  it("lets deletes and drops through over the storage limit, so room can be made", async () => {
    const token = await login(deployment, u("ann"));
    const db = t === "rest" ? restDb(deployment, token) : await rpcDb(deployment, token);
    sockets.push(db);
    const p = `dbroom-${t}`;
    await db.exec(p, "notes", "CREATE TABLE t (x)");
    await db.exec(p, "notes", "INSERT INTO t VALUES (1), (2)");
    // Now the project is over its limit.
    await seed(deployment, ADMIN_KEY, {
      [`/${p}/.system/limits`]: limits({ meter: "storage_bytes", level: "project", value: 0 }),
    });
    await expect(db.exec(p, "notes", "INSERT INTO t VALUES (3)")).rejects.toMatchObject({
      message: expect.stringContaining("ENOSPC"),
    });
    await db.exec(p, "notes", "DELETE FROM t");
    await db.exec(p, "notes", "DROP TABLE t");
  });

  it("answers 429 to a stream over the member's limit on concurrent streams, until one ends", async () => {
    const sam = await as("sam");
    const s = await sam.startSession({ project: `sessions-${t}` });
    const held = await sam.postMessage(s.id, { content: `HOLD streams-${t}` });
    const queued = await sam.postMessage(s.id, { content: "hello" });
    await model.held(`streams-${t}`);
    // Following both turns at once takes two streams (SSE streams, or long polls over RPC): the
    // one that comes second is refused while the other waits on the held turn.
    const following = [sam.waitTurn(held), sam.waitTurn(queued)];
    const refused = await Promise.race(following.map((p) => p.catch((e: unknown) => e)));
    expect(refused).toMatchObject({ status: 429, message: expect.stringContaining("streams") });
    model.release(`streams-${t}`);
    const outcomes = await Promise.allSettled(following);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    // That stream ended, so another may open.
    expect(await sam.waitTurn(queued)).toMatchObject({ status: "completed" });
  });

  it("holds each workspace to the deployment's limits in its own DO, with no global counter", async () => {
    const at = async (workspace: string) =>
      connect(ceilinged, await login(ceilinged, u("ann"), { workspace }));
    const inDefault = await at(`${t}1`);
    const s = await inDefault.startSession({ project: `ceiling-${t}` });
    expect(await inDefault.sendMessage(s.id, { content: "hello" })).toMatchObject({
      status: "completed",
    });
    await expect(inDefault.postMessage(s.id, { content: "hello" })).rejects.toMatchObject({
      status: 429,
      message: expect.stringContaining("deployment limit"),
    });
    // The other workspace is held to its own ceiling, not to what the first one used.
    const inOther = await at(`${t}2`);
    const o = await inOther.startSession({ project: `ceiling-${t}` });
    expect(await inOther.sendMessage(o.id, { content: "hello" })).toMatchObject({
      status: "completed",
    });
  });
});
