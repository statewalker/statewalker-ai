// Databases (statewalker/statewalker-root#136, decided in #81): named SQLite databases belong to a
// project, declared in its `.system/databases`, each its own DO behind the Workspace DO's gate.
// Holders get db-api's `Db` over RPC (the session API's /v1/databases channel, db-rpc's protocol,
// large results page by page) or over REST; agents through the harness's database tools. `db.read`
// alone runs every call in a transaction that is always rolled back; `db.write` writes under the
// mode (`plan` and `default` ask, `acceptEdits` allows); owners create and drop databases (`db.admin`).
// A plugin's tool-private databases (`<plugin>:<name>`) are reached only by that plugin's tools.
// Run against the harness's own deployment (ai-host-do) on CellB Node in-process, with the
// scripted model, over REST and RPC.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Approval,
  type DbClient,
  type Deployment,
  databaseStorage,
  type FakeModel,
  fakeModel,
  login,
  type RpcDbClient,
  restClient,
  restDb,
  rpcClient,
  rpcDb,
  type SessionClient,
  seed,
  startDeployment,
  type Turn,
  toolDb,
} from "../src/index.js";

const HOST = new URL("../../ai-host-do/", import.meta.url);
const ADMIN_KEY = "conformance-admin-key";
const AP = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

/** A plugin with one tool, `search/reindex`, that keeps a private index. */
const CATALOG = {
  "/search/plugin.json": JSON.stringify({ $schema: AP, name: "search", version: "1.0.0" }),
  "/search/dev.cellb.harness/tools/openapi.json": JSON.stringify({
    openapi: "3.1.0",
    info: { title: "search", version: "1.0.0" },
    paths: { "/tools/search/reindex": { post: { operationId: "reindex" } } },
  }),
  "/search/dev.cellb.harness/tools/reindex.js": "export default async () => null;",
  "/other/plugin.json": JSON.stringify({ $schema: AP, name: "other", version: "1.0.0" }),
  "/other/dev.cellb.harness/tools/openapi.json": JSON.stringify({
    openapi: "3.1.0",
    info: { title: "other", version: "1.0.0" },
    paths: { "/tools/other/peek": { post: { operationId: "peek" } } },
  }),
  "/other/dev.cellb.harness/tools/peek.js": "export default async () => null;",
};

const TRANSPORTS = ["rest", "rpc"];

function fixtures(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const t of TRANSPORTS) {
    const p = `data-${t}`;
    files[`/${p}/readme.md`] = "# data\n";
    files[`/${p}/.system/access`] = JSON.stringify({
      [`own-${t}`]: "owner",
      [`ed-${t}`]: "editor",
      [`rd-${t}`]: "reader",
      [`dee-${t}`]: "editor",
      [`pam-${t}`]: "editor",
      [`ace-${t}`]: "editor",
      [`don-${t}`]: "editor",
      [`tia-${t}`]: "editor",
      [`max-${t}`]: "editor",
    });
    files[`/${p}/.system/databases`] = JSON.stringify({ notes: {}, big: {} });
    // Another project, which data's members are not in.
    files[`/elsewhere-${t}/.system/access`] = JSON.stringify({ [`zed-${t}`]: "owner" });
    files[`/elsewhere-${t}/.system/databases`] = JSON.stringify({ notes: {} });
    // A project whose access file a scenario rewrites.
    files[`/demote-${t}/.system/access`] = JSON.stringify({
      [`own-${t}`]: "owner",
      [`eva-${t}`]: "editor",
    });
    files[`/demote-${t}/.system/databases`] = JSON.stringify({ notes: {} });
  }
  return files;
}

type Connect = (deployment: Deployment, token: string) => Promise<SessionClient & DbClient>;
const sockets: { close(): void }[] = [];
const transports: [string, Connect][] = [
  [
    "REST",
    async (d, token) => {
      const db = restDb(d, token);
      return Object.assign(restClient(d, token), db);
    },
  ],
  [
    "RPC",
    async (d, token) => {
      const client = await rpcClient(d, token);
      const db = await rpcDb(d, token);
      sockets.push(client, db);
      return Object.assign(client, {
        listDatabases: db.listDatabases,
        query: db.query,
        exec: db.exec,
      }) as SessionClient & DbClient;
    },
  ],
];

let model: FakeModel;
let deployment: Deployment;

beforeAll(async () => {
  model = await fakeModel();
  deployment = await startDeployment(HOST, {
    MODELS: model.deploymentModels(),
    DEV_LOGIN: "true",
    ADMIN_KEY,
    CATALOG: JSON.stringify(CATALOG),
  });
  await seed(deployment, ADMIN_KEY, fixtures());
}, 120_000);
afterAll(async () => {
  for (const s of sockets) s.close();
  await deployment?.close();
  await model?.close();
});

const call = (tool: string, args: unknown) => `CALL ${tool} ${JSON.stringify(args)}`;
const toolResult = (turn: Turn) => turn.items.find((i) => i.kind === "tool_result");
/** What the model was last shown (tests of a file run one at a time): its last request's texts. */
const lastAsked = (): string =>
  (model.requests.filter((r) => !r.classifier && !r.summary).at(-1)?.messages ?? [])
    .map((m) => m.text)
    .join("\n");
const approvalOf = async (client: SessionClient, turn: Turn): Promise<Approval> => {
  expect(turn.status).toBe("waiting");
  const id = turn.stop_reason?.approval_ids?.[0];
  const found = (await client.listApprovals()).approvals.find((a) => a.id === id);
  expect(found).toBeDefined();
  return found as Approval;
};

describe.each(transports)("databases over %s", (name, connect) => {
  const t = name.toLowerCase();
  const p = `data-${t}`;
  const as = async (user: string) => connect(deployment, await login(deployment, `${user}-${t}`));

  it("lists a project's declared databases to its members, with what each may do", async () => {
    const own = await as("own");
    const rd = await as("rd");
    expect((await own.listDatabases(p)).databases.map((d) => [d.name, d.access])).toEqual([
      ["big", "write"],
      ["notes", "write"],
    ]);
    expect((await rd.listDatabases(p)).databases.map((d) => [d.name, d.access])).toEqual([
      ["big", "read"],
      ["notes", "read"],
    ]);
    await expect(rd.listDatabases(`elsewhere-${t}`)).rejects.toMatchObject({ status: 403 });
  });

  it("gives holders a Db over the session API, and streams a large result page by page", async () => {
    const own = await as("own");
    await own.exec(p, "big", "CREATE TABLE IF NOT EXISTS n (i INTEGER PRIMARY KEY, label TEXT)");
    await own.exec(
      p,
      "big",
      "INSERT INTO n (i, label) WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 5000) SELECT x, 'row ' || x FROM c",
    );
    const rows = await own.query<{ i: number; label: string }>(
      p,
      "big",
      "SELECT * FROM n ORDER BY i",
    );
    expect(rows).toHaveLength(5000);
    expect(rows[0]).toEqual({ i: 1, label: "row 1" });
    expect(rows[4999]).toEqual({ i: 5000, label: "row 5000" });
    expect(await own.query(p, "big", "SELECT label FROM n WHERE i = ?", [42])).toEqual([
      { label: "row 42" },
    ]);
    // A database counts toward the workspace's storage.
    const listed = (await own.listDatabases(p)).databases.find((d) => d.name === "big");
    expect(listed?.bytes).toBeGreaterThan(0);
  });

  it("runs a call with only db.read in a transaction that is always rolled back", async () => {
    const own = await as("own");
    const rd = await as("rd");
    await own.exec(p, "notes", "CREATE TABLE IF NOT EXISTS ro (v TEXT)");
    await own.exec(p, "notes", "DELETE FROM ro");
    await own.exec(p, "notes", "INSERT INTO ro (v) VALUES ('kept')");
    expect(await rd.query(p, "notes", "SELECT v FROM ro")).toEqual([{ v: "kept" }]);
    // A reader's write runs inside its call and never persists.
    await rd.exec(p, "notes", "INSERT INTO ro (v) VALUES ('lost')");
    expect(await rd.query(p, "notes", "DELETE FROM ro RETURNING v")).toEqual([{ v: "kept" }]);
    await rd.exec(p, "notes", "DROP TABLE ro");
    expect(await own.query(p, "notes", "SELECT v FROM ro")).toEqual([{ v: "kept" }]);
    // Statements that would end the transaction are refused.
    await expect(rd.exec(p, "notes", "COMMIT")).rejects.toThrow(/read-only|not authorized/);
  });

  it("refuses a database the holder may not reach or the project does not declare", async () => {
    const rd = await as("rd");
    await expect(rd.query(`elsewhere-${t}`, "notes", "SELECT 1")).rejects.toMatchObject({
      status: 403,
    });
    await expect(rd.query(p, "missing", "SELECT 1")).rejects.toMatchObject({ status: 404 });
    await expect(rd.query(p, "search:index", "SELECT 1")).rejects.toMatchObject({ status: 404 });
    await expect(rd.query(p, "../notes", "SELECT 1")).rejects.toMatchObject({ status: 404 });
  });

  it("lets an owner create and drop a database through the harness tool, and nobody else", async () => {
    const own = await as("own");
    const ed = await as("ed");
    await own.setMode({ mode: "bypassPermissions" });
    await ed.setMode({ mode: "bypassPermissions" });
    const so = await own.startSession({ project: p });
    const created = await own.sendMessage(so.id, {
      content: call("db_create", { database: "scratch" }),
    });
    expect(toolResult(created)).toMatchObject({ isError: false });
    expect((await own.listDatabases(p)).databases.map((d) => d.name)).toContain("scratch");
    await own.exec(p, "scratch", "CREATE TABLE s (v TEXT)");
    await own.exec(p, "scratch", "INSERT INTO s VALUES ('x')");
    // An editor may use it but not drop it, nor create another.
    const se = await ed.startSession({ project: p });
    const listed = await ed.sendMessage(se.id, { content: call("db_list", {}) });
    expect(toolResult(listed)?.output).toContain("scratch");
    for (const content of [
      call("db_drop", { database: "scratch" }),
      call("db_create", { database: "mine" }),
    ]) {
      const refused = await ed.sendMessage(se.id, { content });
      expect(toolResult(refused)).toMatchObject({ isError: true });
      expect(toolResult(refused)?.output).toMatch(/EACCES/);
    }
    // Creating an existing one is refused; dropping removes it and its data.
    const again = await own.sendMessage(so.id, {
      content: call("db_create", { database: "scratch" }),
    });
    expect(toolResult(again)?.output).toMatch(/EEXIST/);
    const dropped = await own.sendMessage(so.id, {
      content: call("db_drop", { database: "scratch" }),
    });
    expect(toolResult(dropped)).toMatchObject({ isError: false });
    expect((await own.listDatabases(p)).databases.map((d) => d.name)).not.toContain("scratch");
    await expect(own.query(p, "scratch", "SELECT 1")).rejects.toMatchObject({ status: 404 });
    await own.sendMessage(so.id, { content: call("db_create", { database: "scratch" }) });
    expect(
      await own.query(p, "scratch", "SELECT count(*) AS n FROM sqlite_master WHERE name = 's'"),
    ).toEqual([{ n: 0 }]);
  });

  it("lets agents query and write through the harness tools; default mode asks before a write", async () => {
    const own = await as("own");
    await own.exec(p, "notes", "CREATE TABLE IF NOT EXISTS todo (v TEXT)");
    const dee = await as("dee");
    const s = await dee.startSession({ project: p });
    const read = await dee.sendMessage(s.id, {
      content: call("db_query", { database: "notes", sql: "SELECT count(*) AS n FROM todo" }),
    });
    expect(toolResult(read)).toMatchObject({ isError: false });
    expect(JSON.parse(String(toolResult(read)?.output))).toEqual([{ n: expect.any(Number) }]);
    const insert = call("db_exec", { database: "notes", sql: "INSERT INTO todo VALUES ('dee')" });
    const approval = await approvalOf(dee, await dee.sendMessage(s.id, { content: insert }));
    expect(approval).toMatchObject({
      session: s.id,
      project: p,
      action: { method: "db", path: "notes" },
      permission: "db.write:notes",
    });
    expect(await own.query(p, "notes", "SELECT v FROM todo WHERE v = 'dee'")).toEqual([]);
    const { accepted } = await dee.answerApproval(approval.id, {
      decision: "allow",
      scope: "once",
    });
    const answered = await dee.waitTurn(accepted);
    expect(toolResult(answered)).toMatchObject({ isError: false, approval: approval.id });
    expect(await own.query(p, "notes", "SELECT v FROM todo WHERE v = 'dee'")).toEqual([
      { v: "dee" },
    ]);
    // The agent continues the turn with the write's result (statewalker/statewalker-root#214).
    expect(answered.status).toBe("completed");
    expect(answered.items.map((i) => i.kind)).toEqual(["tool_result", "message"]);
    expect(lastAsked()).toContain("[Result of an approved action] db notes:");
  });

  it("continues a turn waiting on several approvals once the last one is answered", async () => {
    const own = await as("own");
    await own.exec(p, "notes", "CREATE TABLE IF NOT EXISTS pair (v TEXT)");
    const max = await as("max");
    const s = await max.startSession({ project: p });
    // One answer of two changes, each asking: a file write and a database write.
    const turn = await max.sendMessage(s.id, {
      content: [
        call("write", { path: "pair.md", content: "pair\n" }),
        call("db_exec", { database: "notes", sql: "INSERT INTO pair VALUES ('max')" }),
      ].join("\n"),
    });
    expect(turn.status).toBe("waiting");
    const ids = turn.stop_reason?.approval_ids ?? [];
    expect(ids).toHaveLength(2);
    const approvals = (await max.listApprovals()).approvals;
    const file = approvals.find((a) => ids.includes(a.id) && a.action.method === "write");
    const db = approvals.find((a) => ids.includes(a.id) && a.action.method === "db");
    expect(file && db).toBeTruthy();
    const asked = model.requests.length;
    // The first answer runs its action; the turn still waits on the other, the model not asked.
    const first = await max.answerApproval(String(db?.id), { decision: "allow", scope: "once" });
    const waiting = await max.waitTurn(first.accepted);
    expect(waiting.status).toBe("waiting");
    expect(waiting.stop_reason).toMatchObject({ type: "approval", approval_ids: [file?.id] });
    expect(waiting.items.map((i) => i.kind)).toEqual(["tool_result"]);
    expect(model.requests.length).toBe(asked);
    expect(await own.query(p, "notes", "SELECT v FROM pair")).toEqual([{ v: "max" }]);
    // The last answer continues the turn, with both results.
    const last = await max.answerApproval(String(file?.id), {
      decision: "deny",
      scope: "once",
      message: "no files",
    });
    const done = await max.waitTurn(last.accepted);
    expect(done.status).toBe("completed");
    expect(done.items.map((i) => i.kind)).toEqual(["tool_result", "message"]);
    const shown = lastAsked();
    expect(shown).toContain("[Result of an approved action] db notes:");
    expect(shown).toContain(
      `[Result of a denied action] write /${p}/pair.md: denied by the user: no files`,
    );
  });

  it("plan mode reads databases and asks before writes; acceptEdits writes; dontAsk refuses", async () => {
    const own = await as("own");
    await own.exec(p, "notes", "CREATE TABLE IF NOT EXISTS log (v TEXT)");
    const write = (v: string) =>
      call("db_exec", { database: "notes", sql: `INSERT INTO log VALUES ('${v}')` });
    const pam = await as("pam");
    await pam.setMode({ mode: "plan" });
    const sp = await pam.startSession({ project: p });
    const planRead = await pam.sendMessage(sp.id, {
      content: call("db_query", { database: "notes", sql: "SELECT 1 AS one" }),
    });
    expect(toolResult(planRead)?.output).toBe(JSON.stringify([{ one: 1 }]));
    await approvalOf(pam, await pam.sendMessage(sp.id, { content: write("pam") }));
    const ace = await as("ace");
    await ace.setMode({ mode: "acceptEdits" });
    const sa = await ace.startSession({ project: p });
    expect(toolResult(await ace.sendMessage(sa.id, { content: write("ace") }))).toMatchObject({
      isError: false,
    });
    const don = await as("don");
    await don.setMode({ mode: "dontAsk" });
    const sd = await don.startSession({ project: p });
    const denied = await don.sendMessage(sd.id, { content: write("don") });
    expect(denied.status).toBe("completed");
    expect(toolResult(denied)).toMatchObject({ isError: true });
    expect(toolResult(denied)?.output).toMatch(/EACCES/);
    expect(await own.query(p, "notes", "SELECT v FROM log ORDER BY v")).toEqual([{ v: "ace" }]);
  });

  it("runs a reader's agent's writes in a transaction that is always rolled back", async () => {
    const rd = await as("rd");
    const s = await rd.startSession({ project: p });
    const own = await as("own");
    await own.exec(p, "notes", "CREATE TABLE IF NOT EXISTS rdlog (v TEXT)");
    await rd.setMode({ mode: "bypassPermissions" });
    const wrote = await rd.sendMessage(s.id, {
      content: call("db_exec", { database: "notes", sql: "INSERT INTO rdlog VALUES ('rd')" }),
    });
    expect(toolResult(wrote)).toMatchObject({ isError: false });
    expect(await own.query(p, "notes", "SELECT v FROM rdlog")).toEqual([]);
  });

  it("a demotion reaches a holder's next database call", async () => {
    const d = `demote-${t}`;
    const own = await as("own");
    const eva = await as("eva");
    await own.exec(d, "notes", "CREATE TABLE IF NOT EXISTS w (v TEXT)");
    await eva.exec(d, "notes", "INSERT INTO w VALUES ('editor')");
    await seed(deployment, ADMIN_KEY, {
      [`/${d}/.system/access`]: JSON.stringify({ [`own-${t}`]: "owner", [`eva-${t}`]: "reader" }),
    });
    await eva.exec(d, "notes", "INSERT INTO w VALUES ('reader')");
    expect(await own.query(d, "notes", "SELECT v FROM w")).toEqual([{ v: "editor" }]);
    await seed(deployment, ADMIN_KEY, {
      [`/${d}/.system/access`]: JSON.stringify({ [`own-${t}`]: "owner" }),
    });
    await expect(eva.query(d, "notes", "SELECT v FROM w")).rejects.toMatchObject({ status: 403 });
  });

  it("lets only a plugin's own tools reach its tool-private databases", async () => {
    const tia = await as("tia");
    const s = await tia.startSession({ project: p });
    const reindex = { plugin: "search", tool: "reindex", database: "search:index" };
    await toolDb(deployment, ADMIN_KEY, s.id, {
      ...reindex,
      op: "exec",
      sql: "CREATE TABLE IF NOT EXISTS terms (term TEXT)",
    });
    await toolDb(deployment, ADMIN_KEY, s.id, {
      ...reindex,
      op: "exec",
      sql: "INSERT INTO terms VALUES ('hello')",
    });
    expect(
      (
        await toolDb(deployment, ADMIN_KEY, s.id, {
          ...reindex,
          op: "query",
          sql: "SELECT term FROM terms",
        })
      ).rows,
    ).toEqual([{ term: "hello" }]);
    // Another plugin's tool, the agent's own tools and the user's own session never reach it.
    await expect(
      toolDb(deployment, ADMIN_KEY, s.id, {
        plugin: "other",
        tool: "peek",
        database: "search:index",
        op: "query",
        sql: "SELECT term FROM terms",
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      toolDb(deployment, ADMIN_KEY, s.id, {
        plugin: "search",
        tool: "nonesuch",
        database: "search:index",
        op: "query",
        sql: "SELECT 1",
      }),
    ).rejects.toMatchObject({ status: 403 });
    const byAgent = await tia.sendMessage(s.id, {
      content: call("db_query", { database: "search:index", sql: "SELECT term FROM terms" }),
    });
    expect(toolResult(byAgent)).toMatchObject({ isError: true });
    const listed = await tia.sendMessage(s.id, { content: call("db_list", {}) });
    expect(toolResult(listed)?.output).not.toContain("search:index");
    await expect(tia.query(p, "search:index", "SELECT 1")).rejects.toMatchObject({ status: 404 });
    // The tool-private database counts toward the workspace's storage too.
    const storage = await databaseStorage(deployment, ADMIN_KEY);
    expect(
      storage.find((d) => d.project === p && d.database === "search:index")?.bytes,
    ).toBeGreaterThan(0);
  });
});

describe("databases over RPC, by hand", () => {
  it("keeps each holder's open results and retried calls its own", async () => {
    const own = (await rpcDb(deployment, await login(deployment, "own-rpc"))) as RpcDbClient;
    const ed = (await rpcDb(deployment, await login(deployment, "ed-rpc"))) as RpcDbClient;
    sockets.push(own, ed);
    await own.exec("data-rpc", "big", "CREATE TABLE IF NOT EXISTS m (i INTEGER)");
    await own.exec(
      "data-rpc",
      "big",
      "INSERT INTO m WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 3000) SELECT x FROM c",
    );
    const streamId = "own-stream-0123456789";
    const first = await own.rpc("data-rpc", "big").query("SELECT i FROM m", [], { streamId });
    expect(first.streamId).toBe(streamId);
    expect(first.pages).toBeGreaterThan(1);
    // The same id names nothing for another holder.
    await expect(ed.rpc("data-rpc", "big").readPage(streamId, 1)).rejects.toMatchObject({
      status: 404,
    });
    expect((await own.rpc("data-rpc", "big").readPage(streamId, 1)).rows.length).toBeGreaterThan(0);
    await own.rpc("data-rpc", "big").closeQuery(streamId);
    // A retried call is the caller's own: another holder's same request id runs its own call.
    const requestId = "shared-request-0123456789";
    await own.rpc("data-rpc", "big").exec("CREATE TABLE IF NOT EXISTS r (who TEXT)", { requestId });
    await ed.rpc("data-rpc", "big").exec("INSERT INTO r VALUES ('ed')", { requestId });
    expect(await own.query("data-rpc", "big", "SELECT who FROM r")).toEqual([{ who: "ed" }]);
  });
});
