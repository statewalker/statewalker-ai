// The turn tree (statewalker/statewalker-root#190, decided in #159): an agent session's turns form
// a tree with a movable head and the context is the path from the first turn to the head. Rewind
// moves the head (rewound turns stay as an inactive branch; their pending approvals are cancelled,
// the sub-agents they started are stopped and archived, and their database and outside effects
// are listed, not reverted); PUT head switches branch; edit and regenerate are a rewind plus a
// sibling turn; a fork copies a turn and its ancestors from any branch into a new session of the
// same agent, project and pinned definitions, with a capability derived afresh and its own
// limits. Run against the harness's own deployment (ai-host-do) on CellB Node in-process, with the
// scripted model, over REST and RPC.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ApiError,
  type Deployment,
  type FakeModel,
  fakeModel,
  login,
  restClient,
  rpcClient,
  type SessionClient,
  seed,
  startDeployment,
  type Turn,
} from "../src/index.js";

const HOST = new URL("../../ai-host-do/", import.meta.url);
const ADMIN_KEY = "conformance-admin-key";
const TRANSPORTS = ["rest", "rpc"];
const USERS = ["ann", "bob", "cy", "dee", "eli", "fay", "gus", "hal", "ivy", "jo", "kim", "lou"];

const AP = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const agentFile = (name: string, agents?: string[]) =>
  `---\nname: ${name}\n${agents ? `agents: [${agents.join(", ")}]\n` : ""}---\nYou are ${name}.\n`;
/** `team/lead` may start `team/helper`. */
const CATALOG: Record<string, string> = {
  "/team/plugin.json": JSON.stringify({ $schema: AP, name: "team" }),
  "/team/dev.cellb.harness/agents/lead.md": agentFile("lead", ["team/*"]),
  "/team/dev.cellb.harness/agents/helper.md": agentFile("helper"),
};

const limits = (...list: Record<string, unknown>[]) => JSON.stringify(list);

function fixtures(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const t of TRANSPORTS) {
    const editors = JSON.stringify(Object.fromEntries(USERS.map((u) => [`${u}-${t}`, "editor"])));
    files[`/tree-${t}/readme.md`] = "# tree\n";
    files[`/tree-${t}/.system/access`] = editors;
    files[`/tree-${t}/.system/databases`] = JSON.stringify({ notes: {} });
    // Two turns a day in all: a fork's first message is refused once they are spent.
    files[`/capped-${t}/.system/access`] = editors;
    files[`/capped-${t}/.system/limits`] = limits({
      meter: "turns",
      level: "project",
      value: 2,
      period: "day",
    });
  }
  return files;
}

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
  deployment = await startDeployment(HOST, {
    MODELS: model.deploymentModels({
      models: [{ id: "scripted/default", alias: "default" }, { id: "scripted/other" }],
      default: "scripted/default",
    }),
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
const write = (path: string, content = "x\n") => call("write", { path, content });
const texts = (turn: Turn) => turn.items.filter((i) => i.kind === "message").map((i) => i.text);
/** What the model was shown for the last request whose last user message was `text`. */
const shown = (text: string) =>
  (
    model.requests.filter((r) => r.lastUserText === text && !r.summary && !r.classifier).at(-1)
      ?.messages ?? []
  )
    .map((m) => m.text)
    .join("\n");

describe.each(transports)("the turn tree over %s", (name, connect) => {
  const t = name.toLowerCase();
  const project = `tree-${t}`;
  const as = async (user: string) => connect(deployment, await login(deployment, `${user}-${t}`));
  let holds = 0;
  const hold = () => `tree-${t}-${++holds}`;

  it("records each turn's parent and origin; after a rewind the next turn is a sibling and sees only the path", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project });
    const a = await ann.sendMessage(s.id, { content: `one ${t}` });
    const b = await ann.sendMessage(s.id, { content: `two ${t}` });
    expect(a).toMatchObject({ parent_turn: null, origin: "run" });
    expect(b).toMatchObject({ parent_turn: a.id, origin: "run" });
    const rewound = await ann.rewind(s.id, { to_turn: a.id });
    expect(rewound).toMatchObject({
      head: a.id,
      previous: b.id,
      rewound: [b.id],
      cancelled_turns: [],
      cancelled_approvals: [],
      stopped_children: [],
    });
    const next = `three ${t}`;
    const c = await ann.sendMessage(s.id, { content: next });
    expect(c).toMatchObject({ session: s.id, parent_turn: a.id, status: "completed" });
    // The new turn starts with an item telling the model of the rewind.
    expect(c.items[0]).toMatchObject({ kind: "rewind", rewind: { head: a.id, turns: [b.id] } });
    const seen = shown(next);
    expect(seen).toContain(`one ${t}`);
    expect(seen).not.toContain(`two ${t}`);
    expect(seen).toContain("[Rewind] The conversation was rewound");
    // The rewound turn stays, as an inactive branch.
    expect((await ann.getTurn(b.id)).status).toBe("completed");
    expect((await ann.getSession(s.id)).id).toBe(s.id);
  });

  it("rewinds before a turn, switches branch with PUT head, and tells every viewer", async () => {
    const bob = await as("bob");
    const s = await bob.startSession({ project });
    const a = await bob.sendMessage(s.id, { content: "first" });
    const b = await bob.sendMessage(s.id, { content: "second" });
    const viewer = await as("bob");
    const { offset } = await viewer.readEvents(s.id);
    expect((await bob.rewind(s.id, { before_turn: b.id })).head).toBe(a.id);
    const c = await bob.sendMessage(s.id, { content: "other" });
    const switched = await bob.setHead(s.id, { turn: b.id });
    expect(switched).toMatchObject({ head: b.id, previous: c.id, rewound: [c.id] });
    const { events } = await viewer.readEvents(s.id, { since: offset });
    expect(
      events
        .filter((e) => e.type.startsWith("session."))
        .map((e) => [e.type, (e.data as { head: string | null }).head]),
    ).toEqual([
      ["session.rewound", a.id],
      ["session.head_changed", a.id],
      ["session.head_changed", b.id],
    ]);
    const tree = await bob.listBranches(s.id);
    expect(tree.head).toBe(b.id);
    expect(tree.turns.map((x) => [x.id, x.parent_turn, x.active])).toEqual([
      [a.id, null, true],
      [b.id, a.id, true],
      [c.id, a.id, false],
    ]);
    expect([...tree.leaves].sort()).toEqual([b.id, c.id].sort());
    // Rewinding to the start: the next turn is a first turn again.
    expect((await bob.rewind(s.id, { to_turn: null })).head).toBeNull();
    expect((await bob.sendMessage(s.id, { content: "anew" })).parent_turn).toBeNull();
  });

  it("refuses a rewind, a branch switch, an edit and a fork from a running turn (409) unless the rewind cancels it", async () => {
    const cy = await as("cy");
    const s = await cy.startSession({ project });
    const a = await cy.sendMessage(s.id, { content: "steady" });
    const h = hold();
    const running = await cy.postMessage(s.id, { content: `HOLD ${h}` });
    await model.held(h);
    await expect(cy.rewind(s.id, { to_turn: a.id })).rejects.toMatchObject({ status: 409 });
    await expect(cy.setHead(s.id, { turn: a.id })).rejects.toMatchObject({ status: 409 });
    await expect(cy.editTurn(a.id, { content: "changed" })).rejects.toMatchObject({
      status: 409,
    });
    await expect(cy.forkSession(s.id, { at_turn: running.turn_id })).rejects.toMatchObject({
      status: 409,
    });
    const result = await cy.rewind(s.id, { to_turn: a.id, cancel_running: true });
    expect(result).toMatchObject({ head: a.id, cancelled_turns: [running.turn_id] });
    expect((await cy.getTurn(running.turn_id)).status).toBe("cancelled");
    model.release(h);
  });

  it("records edit and regenerate as a rewind plus a turn: sibling turns", async () => {
    const dee = await as("dee");
    const s = await dee.startSession({ project });
    const a = await dee.sendMessage(s.id, { content: "base" });
    const b = await dee.sendMessage(s.id, { content: "draft" });
    const edited = await dee.editTurn(b.id, { content: "final" });
    expect(edited).toMatchObject({ session_id: s.id, rewind: { head: a.id, rewound: [b.id] } });
    const e = await dee.waitTurn(edited);
    expect(e).toMatchObject({ parent_turn: a.id, status: "completed" });
    expect(texts(e)).toContain("final");
    const again = await dee.regenerateTurn(e.id, { model: "scripted/other" });
    expect(again.rewind).toMatchObject({ head: a.id, rewound: [e.id] });
    const r = await dee.waitTurn(again);
    expect(r).toMatchObject({ parent_turn: a.id, model: "scripted/other" });
    expect(r.items.find((i) => i.kind === "message" && i.role === "user")?.text).toBe("final");
    const siblings = (await dee.listBranches(s.id)).turns.filter((x) => x.parent_turn === a.id);
    expect(siblings.map((x) => x.id)).toEqual([b.id, e.id, r.id]);
  });

  it("lists items on the active path by default, a branch's with ?branch= and all with ?all=true", async () => {
    const eli = await as("eli");
    const s = await eli.startSession({ project });
    const a = await eli.sendMessage(s.id, { content: "root" });
    const b = await eli.sendMessage(s.id, { content: "left" });
    await eli.rewind(s.id, { to_turn: a.id });
    const c = await eli.sendMessage(s.id, { content: "right" });
    const turns = async (q: { branch?: string; all?: boolean } = {}) => [
      ...new Set((await eli.listItems(s.id, q)).items.map((i) => i.turn)),
    ];
    expect(await turns()).toEqual([a.id, c.id]);
    expect(await turns({ branch: b.id })).toEqual([a.id, b.id]);
    expect(await turns({ all: true })).toEqual([a.id, b.id, c.id]);
  });

  it("erases an inactive branch for its owner, never the active path; no one else reaches the tree", async () => {
    const fay = await as("fay");
    const gus = await as("gus");
    const s = await fay.startSession({ project });
    const a = await fay.sendMessage(s.id, { content: "keep" });
    const b = await fay.sendMessage(s.id, { content: "drop" });
    await fay.rewind(s.id, { to_turn: a.id });
    const c = await fay.sendMessage(s.id, { content: "instead" });
    // Another member of the project: the session is not theirs (404 everywhere).
    await expect(gus.listBranches(s.id)).rejects.toMatchObject({ status: 404 });
    await expect(gus.rewind(s.id, { to_turn: a.id })).rejects.toMatchObject({ status: 404 });
    await expect(gus.setHead(s.id, { turn: b.id })).rejects.toMatchObject({ status: 404 });
    await expect(gus.eraseBranch(s.id, b.id)).rejects.toMatchObject({ status: 404 });
    await expect(gus.editTurn(b.id, { content: "mine" })).rejects.toMatchObject({ status: 404 });
    await expect(gus.regenerateTurn(b.id)).rejects.toMatchObject({ status: 404 });
    await expect(gus.forkSession(s.id, { at_turn: b.id })).rejects.toMatchObject({ status: 404 });
    // The active path is never erased.
    await expect(fay.eraseBranch(s.id, c.id)).rejects.toMatchObject({ status: 400 });
    await expect(fay.eraseBranch(s.id, a.id)).rejects.toMatchObject({ status: 400 });
    expect(await fay.eraseBranch(s.id, b.id)).toEqual({ erased: [b.id] });
    await expect(fay.getTurn(b.id)).rejects.toMatchObject({ status: 404 });
    expect((await fay.listBranches(s.id)).turns.map((x) => x.id)).toEqual([a.id, c.id]);
    expect((await fay.listItems(s.id, { all: true })).items.some((i) => i.turn === b.id)).toBe(
      false,
    );
  });

  it("cancels the pending approvals of rewound turns: answering them is refused", async () => {
    const hal = await as("hal");
    const s = await hal.startSession({ project });
    const a = await hal.sendMessage(s.id, { content: "before" });
    // The default mode asks before a write.
    const w = await hal.sendMessage(s.id, { content: write(`/${project}/asked-${t}.md`) });
    expect(w.status).toBe("waiting");
    const id = String(w.stop_reason?.approval_ids?.[0]);
    const result = await hal.rewind(s.id, { before_turn: w.id });
    expect(result).toMatchObject({ head: a.id, cancelled_approvals: [id] });
    const listed = (await hal.listApprovals()).approvals.find((x) => x.id === id);
    expect(listed?.status).toBe("cancelled");
    await expect(
      hal.answerApproval(id, { decision: "allow", scope: "once" }),
    ).rejects.toMatchObject({ status: 400 });
    expect((await hal.getSession(s.id)).status).toBe("idle");
  });

  it("stops and archives the sub-agents rewound turns started; only top-level sessions fork", async () => {
    const ivy = await as("ivy");
    const s = await ivy.startSession({ project, agent: "team/lead" });
    const a = await ivy.sendMessage(s.id, { content: "plan" });
    const started = await ivy.sendMessage(s.id, {
      content: call("agent_start", { agent: "team/helper", message: "help" }),
    });
    expect(started.status).toBe("completed");
    const child = (await ivy.listSessions()).sessions.find((x) => x.parent === s.id);
    expect(child).toBeDefined();
    const childTurn = (await ivy.listItems(String(child?.id))).items[0]?.turn as string;
    await expect(ivy.forkSession(String(child?.id), { at_turn: childTurn })).rejects.toMatchObject({
      status: 400,
    });
    const result = await ivy.rewind(s.id, { to_turn: a.id });
    expect(result.stopped_children).toEqual([child?.id]);
    const stopped = await ivy.getSession(String(child?.id));
    expect(stopped.archived).toEqual(expect.any(Number));
    expect(stopped.revoked).toBe(true);
    // The parent goes on.
    expect((await ivy.sendMessage(s.id, { content: "on" })).status).toBe("completed");
  });

  it("lists the database changes of rewound turns, which it does not revert", async () => {
    const jo = await as("jo");
    await jo.setMode({ mode: "bypassPermissions" });
    const s = await jo.startSession({ project });
    const a = await jo.sendMessage(s.id, { content: "start" });
    const sql = `CREATE TABLE IF NOT EXISTS kept_${t} (v TEXT)`;
    const changed = await jo.sendMessage(s.id, {
      content: call("db_exec", { database: "notes", sql }),
    });
    expect(changed.items.find((i) => i.kind === "tool_result")).toMatchObject({ isError: false });
    const result = await jo.rewind(s.id, { to_turn: a.id });
    expect(result.database_changes).toEqual([
      expect.objectContaining({
        turn: changed.id,
        name: "db_exec",
        args: { database: "notes", sql },
      }),
    ]);
    expect(result.memory_writes).toEqual([]);
    expect(result.irreversible_effects).toEqual([]);
    const next = await jo.sendMessage(s.id, { content: "after" });
    expect(next.items[0]?.text).toContain("database changes (db_exec)");
  });
});

describe.each(transports)("forks over %s", (name, connect) => {
  const t = name.toLowerCase();
  const project = `tree-${t}`;
  const as = async (user: string) => connect(deployment, await login(deployment, `${user}-${t}`));

  it("copies a turn of any branch and its ancestors into a new session: new ids, copied_from, forked_from", async () => {
    const ann = await as("kim");
    const s = await ann.startSession({ project, agent: "team/lead" });
    const a = await ann.sendMessage(s.id, { content: "alpha" });
    const b = await ann.sendMessage(s.id, { content: "beta" });
    await ann.rewind(s.id, { to_turn: a.id });
    await ann.sendMessage(s.id, { content: "gamma" });
    const { session: fork, accepted } = await ann.forkSession(s.id, { at_turn: b.id });
    expect(accepted).toBeUndefined();
    expect(fork).toMatchObject({
      project,
      agent: "team/lead",
      forked_from: { session: s.id, turn: b.id },
    });
    expect(fork.id).not.toBe(s.id);
    expect(fork.parent).toBeUndefined();
    const tree = await ann.listBranches(fork.id);
    expect(tree.turns).toHaveLength(2);
    expect(tree.turns.every((x) => x.origin === "copied" && x.id.startsWith(`${fork.id}.`))).toBe(
      true,
    );
    expect(tree.head).toBe(tree.turns[1]?.id);
    const copied = await ann.getTurn(String(tree.turns[1]?.id));
    expect(copied).toMatchObject({
      origin: "copied",
      copied_from: { session: s.id, turn: b.id },
      parent_turn: tree.turns[0]?.id,
    });
    const { items } = await ann.listItems(fork.id);
    expect(items.map((i) => i.text)).toEqual(["alpha", "OK", "beta", "OK"]);
    expect(items.some((i) => i.turn.startsWith(s.id))).toBe(false);
    expect((await ann.getSession(fork.id)).status).toBe("idle");
  });

  it("forks and sends in one step: the fork's turn continues the copy", async () => {
    const lou = await as("lou");
    const s = await lou.startSession({ project });
    const a = await lou.sendMessage(s.id, { content: `left ${t}` });
    await lou.sendMessage(s.id, { content: `right ${t}` });
    const message = `fork message ${t}`;
    const { session: fork, accepted } = await lou.forkSession(s.id, { at_turn: a.id, message });
    expect(accepted).toMatchObject({ session_id: fork.id, delivery: "next" });
    const turn = await lou.waitTurn(accepted as NonNullable<typeof accepted>);
    expect(turn).toMatchObject({ status: "completed", origin: "run" });
    expect((await lou.listBranches(fork.id)).turns[0]?.id).toBe(turn.parent_turn);
    const seen = shown(message);
    expect(seen).toContain(`left ${t}`);
    expect(seen).not.toContain(`right ${t}`);
  });

  it("leaves no session when the fork's first message is refused, and charges nothing for copied history", async () => {
    const ann = await as("ann");
    const capped = `capped-${t}`;
    const s = await ann.startSession({ project: capped });
    const a = await ann.sendMessage(s.id, { content: "one" });
    await ann.sendMessage(s.id, { content: "two" });
    const before = (await ann.listSessions()).sessions.length;
    // The project's two turns are spent: the fork's message is refused, and nothing is left.
    const refused = await ann
      .forkSession(s.id, { at_turn: a.id, message: "three" })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({ status: 429 });
    expect((await ann.listSessions()).sessions.length).toBe(before);
    // Without a message nothing is charged: copying history is no turn.
    const { session } = await ann.forkSession(s.id, { at_turn: a.id });
    expect((await ann.listItems(session.id)).items.length).toBe(2);
  });

  it("gives a fork its own session limits, counted afresh", async () => {
    const bob = await as("bob");
    const s = await bob.startSession({
      project,
      limits: [{ meter: "turns", value: 2, period: "total" }],
    });
    await bob.sendMessage(s.id, { content: "one" });
    const b = await bob.sendMessage(s.id, { content: "two" });
    await expect(bob.postMessage(s.id, { content: "three" })).rejects.toMatchObject({
      status: 429,
    });
    const { session: fork, accepted } = await bob.forkSession(s.id, {
      at_turn: b.id,
      message: "three",
    });
    expect((await bob.waitTurn(accepted as NonNullable<typeof accepted>)).status).toBe("completed");
    await bob.sendMessage(fork.id, { content: "four" });
    // The fork keeps the source's limit on turns, counted in its own DO.
    await expect(bob.postMessage(fork.id, { content: "five" })).rejects.toMatchObject({
      status: 429,
    });
  });

  it("derives a fork's capability afresh: an approval given for the source session is asked again", async () => {
    const cy = await as("cy");
    const s = await cy.startSession({ project });
    const path = `/${project}/session-scope-${t}.md`;
    const w = await cy.sendMessage(s.id, { content: write(path) });
    expect(w.status).toBe("waiting");
    const id = String(w.stop_reason?.approval_ids?.[0]);
    const { accepted } = await cy.answerApproval(id, { decision: "allow", scope: "session" });
    await cy.waitTurn(accepted);
    // The source writes it again without asking: the approval holds for that session.
    const again = await cy.sendMessage(s.id, { content: write(path, "y\n") });
    expect(again.status).toBe("completed");
    const { accepted: forked } = await cy.forkSession(s.id, {
      at_turn: again.id,
      message: write(path, "z\n"),
    });
    const turn = await cy.waitTurn(forked as NonNullable<typeof forked>);
    expect(turn.status).toBe("waiting");
  });

  it("keeps a fork when its source is deleted", async () => {
    const dee = await as("dee");
    const s = await dee.startSession({ project });
    const a = await dee.sendMessage(s.id, { content: "lasting" });
    const { session: fork } = await dee.forkSession(s.id, { at_turn: a.id });
    await dee.deleteSession(s.id);
    await expect(dee.getSession(s.id)).rejects.toMatchObject({ status: 404 });
    expect((await dee.listItems(fork.id)).items.map((i) => i.text)).toEqual(["lasting", "OK"]);
    const next = await dee.sendMessage(fork.id, { content: "still here" });
    expect(next.status).toBe("completed");
  });
});
