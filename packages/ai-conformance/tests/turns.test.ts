// Messages, turns and events (statewalker/statewalker-root#125, decided in #83 and amended by
// #108): how users send messages (next, steer, interrupt), follow turns, page the session's items
// and read its durable event log, and archive, delete and search sessions. Run against the
// harness's own deployment (ai-host-do) on CellB Node in-process, with the scripted model, over
// REST and RPC.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Deployment,
  type FakeModel,
  fakeModel,
  login,
  restClient,
  rpcClient,
  type SessionClient,
  type SseFrame,
  seed,
  sseFrames,
  startDeployment,
} from "../src/index.js";

const HOST = new URL("../../ai-host-do/", import.meta.url);
const ADMIN_KEY = "conformance-admin-key";
const TRANSPORTS = ["rest", "rpc"];

const FILES = {
  "/alpha/readme.md": "# alpha\n",
  "/alpha/.system/access": JSON.stringify(
    Object.fromEntries(
      TRANSPORTS.flatMap((t) => [
        [`ann-${t}`, "editor"],
        [`bob-${t}`, "reader"],
      ]),
    ),
  ),
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

let model: FakeModel;
let deployment: Deployment;

beforeAll(async () => {
  model = await fakeModel();
  deployment = await startDeployment(HOST, {
    MODELS: model.deploymentModels(),
    DEV_LOGIN: "true",
    ADMIN_KEY,
    SSE_KEEPALIVE_MS: "200",
  });
  await seed(deployment, ADMIN_KEY, FILES);
}, 120_000);
afterAll(async () => {
  for (const s of sockets) s.close();
  await deployment?.close();
  await model?.close();
});

describe.each(transports)("turns over %s", (name, connect) => {
  const t = name.toLowerCase();
  const as = async (user: string) => connect(deployment, await login(deployment, `${user}-${t}`));
  /** A name for a held model request, unique to this transport. */
  let holds = 0;
  const hold = () => `${t}-${++holds}`;

  it("accepts a message with its turn's id, stream URL and offset, and runs the turn on its own", async () => {
    const ann = await as("ann");
    const session = await ann.startSession({ project: "alpha" });
    const h = hold();
    const accepted = await ann.postMessage(session.id, { content: `HOLD ${h}` });
    expect(accepted).toMatchObject({
      turn_id: expect.any(String),
      session_id: session.id,
      delivery: "next",
      stream_url: expect.stringContaining(`/v1/sessions/${session.id}/events`),
      offset: expect.any(Number),
    });
    await model.held(h);
    expect(await ann.getTurn(accepted.turn_id)).toMatchObject({
      id: accepted.turn_id,
      session: session.id,
      status: "running",
    });
    model.release(h);
    const turn = await ann.waitTurn(accepted);
    expect(turn).toMatchObject({ status: "completed", stop_reason: { type: "end_turn" } });
    expect(turn.items.map((i) => [i.role, i.text])).toEqual([
      ["user", `HOLD ${h}`],
      ["assistant", "OK"],
    ]);
    expect(await ann.getTurn(accepted.turn_id)).toMatchObject({ status: "completed" });
  });

  it("queues next messages FIFO behind the running turn", async () => {
    const ann = await as("ann");
    const session = await ann.startSession({ project: "alpha" });
    const h = hold();
    const running = await ann.postMessage(session.id, { content: `HOLD ${h}` });
    await model.held(h);
    const first = await ann.postMessage(session.id, { content: "first", delivery: "next" });
    const second = await ann.postMessage(session.id, { content: "second" });
    expect(await ann.getTurn(first.turn_id)).toMatchObject({ status: "queued", items: [] });
    expect(await ann.getTurn(second.turn_id)).toMatchObject({ status: "queued" });
    model.release(h);
    expect(await ann.waitTurn(second)).toMatchObject({ status: "completed" });
    const { items } = await ann.listItems(session.id);
    expect(items.map((i) => [i.turn, i.role, i.text])).toEqual([
      [running.turn_id, "user", `HOLD ${h}`],
      [running.turn_id, "assistant", "OK"],
      [first.turn_id, "user", "first"],
      [first.turn_id, "assistant", "OK"],
      [second.turn_id, "user", "second"],
      [second.turn_id, "assistant", "OK"],
    ]);
  });

  it("steers the running turn at its next step", async () => {
    const ann = await as("ann");
    const session = await ann.startSession({ project: "alpha" });
    const h = hold();
    const running = await ann.postMessage(session.id, { content: `HOLD ${h}` });
    await model.held(h);
    const steer = await ann.postMessage(session.id, { content: "steered", delivery: "steer" });
    // A steer joins the running turn: no turn of its own.
    expect(steer).toMatchObject({ turn_id: running.turn_id, delivery: "steer" });
    model.release(h);
    const turn = await ann.waitTurn(running);
    expect(turn.status).toBe("completed");
    expect(turn.items.map((i) => [i.role, i.text, i.steer === undefined])).toEqual([
      ["user", `HOLD ${h}`, true],
      ["assistant", "OK", true],
      ["user", "steered", false],
      ["assistant", "OK", true],
    ]);
    expect((await ann.listItems(session.id)).items.every((i) => i.turn === running.turn_id)).toBe(
      true,
    );
    // With no turn running, a steer acts as next.
    const idle = await ann.postMessage(session.id, { content: "alone", delivery: "steer" });
    expect(idle.turn_id).not.toBe(running.turn_id);
    expect(await ann.waitTurn(idle)).toMatchObject({ status: "completed", delivery: "next" });
  });

  it("interrupts the running turn, keeping its items, and runs the interrupting message next", async () => {
    const ann = await as("ann");
    const session = await ann.startSession({ project: "alpha" });
    const h = hold();
    const running = await ann.postMessage(session.id, { content: `HOLD ${h}` });
    await model.held(h);
    const queued = await ann.postMessage(session.id, { content: "queued" });
    const now = await ann.postMessage(session.id, { content: "now", delivery: "interrupt" });
    expect(now).toMatchObject({ delivery: "interrupt" });
    expect(await ann.waitTurn(running)).toMatchObject({
      status: "interrupted",
      stop_reason: { type: "interrupted" },
      items: [{ role: "user", text: `HOLD ${h}` }],
    });
    expect(await ann.waitTurn(now)).toMatchObject({ status: "completed" });
    expect(await ann.waitTurn(queued)).toMatchObject({ status: "completed" });
    const { items } = await ann.listItems(session.id);
    expect(items.map((i) => [i.turn, i.text])).toEqual([
      [running.turn_id, `HOLD ${h}`],
      [now.turn_id, "now"],
      [now.turn_id, "OK"],
      [queued.turn_id, "queued"],
      [queued.turn_id, "OK"],
    ]);
    model.release(h);
  });

  it("runs a steer the turn did not take after the message that interrupted it", async () => {
    const ann = await as("ann");
    const session = await ann.startSession({ project: "alpha" });
    const h = hold();
    const running = await ann.postMessage(session.id, { content: `HOLD ${h}` });
    await model.held(h);
    await ann.postMessage(session.id, { content: "steered", delivery: "steer" });
    const now = await ann.postMessage(session.id, { content: "now", delivery: "interrupt" });
    expect(await ann.waitTurn(running)).toMatchObject({ status: "interrupted" });
    await ann.waitTurn(now);
    const texts = async () =>
      (await ann.listItems(session.id, { types: ["message"] })).items
        .filter((i) => i.role === "user")
        .map((i) => i.text);
    for (let i = 0; i < 100 && (await texts()).length < 3; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(await texts()).toEqual([`HOLD ${h}`, "now", "steered"]);
    model.release(h);
  });

  it("cancels only that turn, running or queued; the other queued messages stay", async () => {
    const ann = await as("ann");
    const session = await ann.startSession({ project: "alpha" });
    const h1 = hold();
    const running = await ann.postMessage(session.id, { content: `HOLD ${h1}` });
    await model.held(h1);
    const h2 = hold();
    const next = await ann.postMessage(session.id, { content: `HOLD ${h2}` });
    const later = await ann.postMessage(session.id, { content: "later" });
    expect(await ann.cancelTurn(running.turn_id)).toMatchObject({
      status: "cancelled",
      stop_reason: { type: "cancelled" },
    });
    await model.held(h2);
    expect(await ann.getTurn(next.turn_id)).toMatchObject({ status: "running" });
    // A queued turn is cancelled without running.
    expect(await ann.cancelTurn(later.turn_id)).toMatchObject({ status: "cancelled", items: [] });
    model.release(h2);
    expect(await ann.waitTurn(next)).toMatchObject({ status: "completed" });
    // A turn that already ended can't be cancelled; another user's can't be reached.
    await expect(ann.cancelTurn(next.turn_id)).rejects.toMatchObject({ status: 409 });
    const bob = await as("bob");
    await expect(bob.getTurn(next.turn_id)).rejects.toMatchObject({ status: 404 });
    await expect(bob.cancelTurn(next.turn_id)).rejects.toMatchObject({ status: 404 });
    await expect(ann.getTurn("no-such-turn")).rejects.toMatchObject({ status: 404 });
    model.release(h1);
  });

  it("ends every turn with a terminal event carrying the full turn", async () => {
    const ann = await as("ann");
    const session = await ann.startSession({ project: "alpha" });
    const accepted = await ann.postMessage(session.id, { content: "hello" });
    const turn = await ann.waitTurn(accepted);
    const { events } = await ann.readEvents(session.id, { since: accepted.offset });
    expect(events.map((e) => e.type)).toEqual([
      "turn.queued",
      "turn.started",
      "item.created",
      "item.created",
      "turn.completed",
    ]);
    expect(events.at(-1)?.data).toEqual(turn);
    expect(turn).toMatchObject({
      id: accepted.turn_id,
      status: "completed",
      stop_reason: { type: "end_turn" },
      model: "scripted/default",
      items: [
        { kind: "message", role: "user", text: "hello" },
        { kind: "message", role: "assistant", text: "OK" },
      ],
    });
    // A failed turn says why.
    const failed = await ann.sendMessage(session.id, { content: "FAIL" });
    expect(failed).toMatchObject({
      status: "failed",
      stop_reason: { type: "error", message: expect.stringMatching(/EIO/) },
    });
  });

  it("reports the request fields it ignored and the model it used instead of the one asked for", async () => {
    const ann = await as("ann");
    const session = await ann.startSession({ project: "alpha" });
    const accepted = await ann.postMessage(session.id, {
      content: "hello",
      model: "gpt-unheard-of",
      temperature: 2,
      tools: [],
    });
    expect(accepted.ignored).toEqual(["temperature", "tools"]);
    const turn = await ann.waitTurn(accepted);
    expect(turn).toMatchObject({
      status: "completed",
      ignored: ["temperature", "tools"],
      model: "scripted/default",
      model_substitution: {
        requested: "gpt-unheard-of",
        used: "scripted/default",
        reason: expect.stringMatching(/configured/),
      },
    });
    expect(model.requests.at(-1)?.model).toBe("default");
    const plain = await ann.sendMessage(session.id, { content: "hello" });
    expect(plain.ignored).toBeUndefined();
    expect(plain.model_substitution).toBeUndefined();
    // A malformed message is refused.
    await expect(ann.postMessage(session.id, { content: "" })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      ann.postMessage(session.id, { content: "x", delivery: "later" as never }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("pages and filters the session's items, and reads one alone", async () => {
    const ann = await as("ann");
    const session = await ann.startSession({ project: "alpha" });
    await ann.sendMessage(session.id, {
      content: `CALL read ${JSON.stringify({ path: "readme.md" })}`,
    });
    await ann.sendMessage(session.id, { content: "two" });
    const all = (await ann.listItems(session.id)).items;
    const kinds = all.map((i) => i.text ?? i.kind);
    expect(kinds).toEqual([
      'CALL read {"path":"readme.md"}',
      "tool_call",
      "tool_result",
      "RESULT: # alpha\n",
      "two",
      "OK",
    ]);
    const ids = all.map((i) => i.id);

    const first = await ann.listItems(session.id, { limit: 2 });
    expect(first).toMatchObject({ has_more: true, first_id: ids[0], last_id: ids[1] });
    expect(first.items.map((i) => i.id)).toEqual(ids.slice(0, 2));
    const second = await ann.listItems(session.id, { limit: 2, after: first.last_id });
    expect(second.items.map((i) => i.id)).toEqual(ids.slice(2, 4));
    const last = await ann.listItems(session.id, { limit: 2, after: second.last_id });
    expect(last).toMatchObject({ has_more: false });
    expect(last.items.map((i) => i.id)).toEqual(ids.slice(4));

    const desc = await ann.listItems(session.id, { order: "desc", limit: 3 });
    expect(desc.items.map((i) => i.id)).toEqual([ids[5], ids[4], ids[3]]);
    const descNext = await ann.listItems(session.id, { order: "desc", after: desc.last_id });
    expect(descNext.items.map((i) => i.id)).toEqual([ids[2], ids[1], ids[0]]);
    const before = await ann.listItems(session.id, { before: ids[2] });
    expect(before.items.map((i) => i.id)).toEqual(ids.slice(0, 2));

    const tools = await ann.listItems(session.id, { types: ["tool_call", "tool_result"] });
    expect(tools.items.map((i) => i.kind)).toEqual(["tool_call", "tool_result"]);

    expect(await ann.getItem(session.id, String(ids[2]))).toEqual(all[2]);
    await expect(ann.getItem(session.id, "it-none")).rejects.toMatchObject({ status: 404 });
    await expect((await as("bob")).getItem(session.id, String(ids[2]))).rejects.toMatchObject({
      status: 404,
    });
    await expect(ann.listItems(session.id, { limit: 0 })).rejects.toMatchObject({ status: 400 });
    await expect(ann.listItems(session.id, { types: ["secret" as never] })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("reads the event log with a cursor that waits for the next event", async () => {
    const ann = await as("ann");
    const session = await ann.startSession({ project: "alpha" });
    const empty = await ann.readEvents(session.id);
    expect(empty).toEqual({ events: [], offset: 0, up_to_date: true });
    const accepted = await ann.postMessage(session.id, { content: "hello" });
    await ann.waitTurn(accepted);
    const page = await ann.readEvents(session.id, { since: 0 });
    expect(page.up_to_date).toBe(true);
    expect(page.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    const tail = await ann.readEvents(session.id, { since: 3 });
    expect(tail.events.map((e) => e.seq)).toEqual([4, 5]);
    await expect((await as("bob")).readEvents(session.id)).rejects.toMatchObject({ status: 404 });
  });

  it("searches the caller's sessions by metadata and status", async () => {
    const ann = await as("ann");
    const tag = `search-${t}-${Date.now()}`;
    const red = await ann.startSession({
      project: "alpha",
      metadata: { tag, color: "red" },
    });
    const blue = await ann.startSession({
      project: "alpha",
      metadata: { tag, color: "blue" },
    });
    expect(red.metadata).toEqual({ tag, color: "red" });
    const ids = async (q: Parameters<SessionClient["listSessions"]>[0]) =>
      (await ann.listSessions(q)).sessions.map((s) => s.id);
    expect(await ids({ metadata: { tag } })).toEqual([red.id, blue.id]);
    expect(await ids({ metadata: { tag, color: "blue" } })).toEqual([blue.id]);
    expect(await ann.updateSession(red.id, { metadata: { tag, color: "green" } })).toMatchObject({
      metadata: { tag, color: "green" },
    });
    expect(await ids({ metadata: { color: "green", tag } })).toEqual([red.id]);
    const h = hold();
    const running = await ann.postMessage(blue.id, { content: `HOLD ${h}` });
    await model.held(h);
    expect(await ids({ metadata: { tag }, status: "running" })).toEqual([blue.id]);
    expect(await ids({ metadata: { tag }, status: "idle" })).toEqual([red.id]);
    expect(await ann.getSession(blue.id)).toMatchObject({ id: blue.id, status: "running" });
    model.release(h);
    await ann.waitTurn(running);
    // Another user's search never finds them; bad metadata is refused.
    expect((await (await as("bob")).listSessions({ metadata: { tag } })).sessions).toEqual([]);
    await expect(
      ann.startSession({ project: "alpha", metadata: { "bad key": "x" } }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(ann.updateSession(red.id, { metadata: { n: 1 as never } })).rejects.toMatchObject({
      status: 400,
    });
    await expect((await as("bob")).updateSession(red.id, { metadata: {} })).rejects.toMatchObject({
      status: 404,
    });
  });

  it("archives a session: its turns end, its history is kept, and it takes no more messages", async () => {
    const ann = await as("ann");
    const session = await ann.startSession({
      project: "alpha",
      metadata: { kept: "yes" },
    });
    const h = hold();
    const running = await ann.postMessage(session.id, { content: `HOLD ${h}` });
    await model.held(h);
    const queued = await ann.postMessage(session.id, { content: "queued" });
    const steer = await ann.postMessage(session.id, { content: "steered", delivery: "steer" });
    const archived = await ann.archiveSession(session.id);
    expect(archived).toMatchObject({
      id: session.id,
      archived: expect.any(Number),
      status: "idle",
    });
    expect(await ann.getTurn(running.turn_id)).toMatchObject({ status: "cancelled" });
    expect(await ann.getTurn(queued.turn_id)).toMatchObject({ status: "cancelled" });
    await expect(ann.postMessage(session.id, { content: "more" })).rejects.toMatchObject({
      status: 409,
    });
    expect((await ann.listItems(session.id)).items.map((i) => i.text)).toEqual([`HOLD ${h}`]);
    // A steer waiting on the cancelled turn never runs in the archived session.
    expect(steer.turn_id).toBe(running.turn_id);
    await new Promise((r) => setTimeout(r, 100));
    expect((await ann.listItems(session.id)).items.map((i) => i.text)).toEqual([`HOLD ${h}`]);
    expect((await ann.readEvents(session.id)).events.at(-1)).toMatchObject({
      type: "session.archived",
    });
    const listed = (await ann.listSessions()).sessions.map((s) => s.id);
    expect(listed).not.toContain(session.id);
    expect((await ann.listSessions({ status: "archived" })).sessions.map((s) => s.id)).toContain(
      session.id,
    );
    model.release(h);
  });

  it("deletes a session and its history, but not while it runs", async () => {
    const ann = await as("ann");
    const session = await ann.startSession({ project: "alpha" });
    const h = hold();
    const running = await ann.postMessage(session.id, { content: `HOLD ${h}` });
    await model.held(h);
    await expect(ann.deleteSession(session.id)).rejects.toMatchObject({ status: 409 });
    await expect((await as("bob")).deleteSession(session.id)).rejects.toMatchObject({
      status: 404,
    });
    model.release(h);
    await ann.waitTurn(running);
    expect(await ann.deleteSession(session.id)).toEqual({ deleted: true });
    await expect(ann.getSession(session.id)).rejects.toMatchObject({ status: 404 });
    await expect(ann.listItems(session.id)).rejects.toMatchObject({ status: 404 });
    await expect(ann.getTurn(running.turn_id)).rejects.toMatchObject({ status: 404 });
    expect((await ann.listSessions()).sessions.map((s) => s.id)).not.toContain(session.id);
  });
});

/** An SSE response's frames, with the reader that ends the connection. */
async function openEvents(path: string, token: string, headers: Record<string, string> = {}) {
  const res = await deployment.fetch(path, {
    headers: { authorization: `Bearer ${token}`, ...headers },
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
  return sseFrames(res.body as ReadableStream<Uint8Array>);
}

/** Frames until one matches (inclusive). */
async function until(frames: AsyncGenerator<SseFrame>, done: (f: SseFrame) => boolean) {
  // Reads with next(), not for-await: leaving a for-await loop would close the stream.
  const seen: SseFrame[] = [];
  for (let r = await frames.next(); !r.done; r = await frames.next()) {
    seen.push(r.value);
    if (done(r.value)) return seen;
  }
  return seen;
}

describe("the event stream over SSE", () => {
  const as = async (user: string) => {
    const token = await login(deployment, `${user}-rest`);
    return { token, client: restClient(deployment, token) };
  };
  let holds = 0;
  const hold = () => `sse-${++holds}`;

  it("streams the durable log from a cursor, resumes from Last-Event-ID and marks up-to-date", async () => {
    const { token, client } = await as("ann");
    const session = await client.startSession({ project: "alpha" });
    await client.sendMessage(session.id, { content: "one" });
    const path = `/v1/sessions/${session.id}/events`;
    const backlog = await until(
      await openEvents(`${path}?since=0`, token),
      (f) => f.event === "up-to-date",
    );
    const events = backlog.filter((f) => f.id);
    expect(events.map((f) => [f.id, f.event])).toEqual([
      ["1", "turn.queued"],
      ["2", "turn.started"],
      ["3", "item.created"],
      ["4", "item.created"],
      ["5", "turn.completed"],
    ]);
    expect(backlog.at(-1)).toMatchObject({
      event: "up-to-date",
      data: JSON.stringify({ offset: 5 }),
    });
    // A reconnecting client repeats its URL; its Last-Event-ID wins.
    const resumed = await until(
      await openEvents(`${path}?since=0`, token, { "last-event-id": "3" }),
      (f) => f.event === "up-to-date",
    );
    expect(resumed.filter((f) => f.id).map((f) => f.id)).toEqual(["4", "5"]);
    const since = await until(
      await openEvents(`${path}?since=4`, token),
      (f) => f.event === "up-to-date",
    );
    expect(since.filter((f) => f.id).map((f) => f.id)).toEqual(["5"]);
    // Live: an event logged after the marker arrives on the open stream.
    const live = await openEvents(`${path}?since=5`, token);
    await until(live, (f) => f.event === "up-to-date");
    await client.postMessage(session.id, { content: "two" });
    const next = await until(live, (f) => !!f.id);
    expect(next.at(-1)).toMatchObject({ id: "6", event: "turn.queued" });
    await live.return(undefined);
  });

  it("sends keep-alives while nothing happens", async () => {
    const { token, client } = await as("ann");
    const session = await client.startSession({ project: "alpha" });
    const frames = await openEvents(`/v1/sessions/${session.id}/events`, token);
    const seen = await until(frames, (f) => f.comment === "keep-alive");
    expect(seen.map((f) => f.event ?? f.comment)).toEqual(["up-to-date", "keep-alive"]);
    await frames.return(undefined);
  });

  it("never cancels a turn when its reader disconnects", async () => {
    const { token, client } = await as("ann");
    const session = await client.startSession({ project: "alpha" });
    const h = hold();
    const accepted = await client.postMessage(session.id, { content: `HOLD ${h}` });
    const frames = await openEvents(accepted.stream_url, token);
    await until(frames, (f) => f.event === "turn.started");
    await frames.return(undefined);
    await model.held(h);
    model.release(h);
    expect(await client.waitTurn(accepted)).toMatchObject({ status: "completed" });
  });

  it("ends a turn's stream with its terminal event, even after the turn ended", async () => {
    const { token, client } = await as("ann");
    const session = await client.startSession({ project: "alpha" });
    const accepted = await client.postMessage(session.id, { content: "done" });
    const seen: SseFrame[] = [];
    for await (const f of await openEvents(accepted.stream_url, token)) seen.push(f);
    expect(seen.at(-1)).toMatchObject({ event: "turn.completed" });
    expect(JSON.parse(String(seen.at(-1)?.data))).toMatchObject({
      id: accepted.turn_id,
      items: [{}, {}],
    });
    // Read again from the end of the log: the stream still ends with the terminal turn.
    const after: SseFrame[] = [];
    for await (const f of await openEvents(
      `/v1/sessions/${session.id}/events?since=999&turn=${accepted.turn_id}`,
      token,
    ))
      after.push(f);
    expect(after.map((f) => f.event)).toEqual(["up-to-date", "turn.completed"]);
  });

  it("ends a session's stream with session.archived, even opened after the archive", async () => {
    const { token, client } = await as("ann");
    const session = await client.startSession({ project: "alpha" });
    await client.archiveSession(session.id);
    const path = `/v1/sessions/${session.id}/events`;
    const all: SseFrame[] = [];
    for await (const f of await openEvents(`${path}?since=0`, token)) all.push(f);
    expect(all.at(-1)).toMatchObject({ id: "1", event: "session.archived" });
    // An EventSource reconnecting after it: the stream still ends at once.
    const again: SseFrame[] = [];
    for await (const f of await openEvents(path, token, { "last-event-id": "1" })) again.push(f);
    expect(again.map((f) => f.event)).toEqual(["up-to-date", "session.archived"]);
  });

  it("refuses an event stream without a valid token or for another user's session", async () => {
    const { client } = await as("ann");
    const session = await client.startSession({ project: "alpha" });
    const path = `/v1/sessions/${session.id}/events`;
    expect((await deployment.fetch(path)).status).toBe(401);
    const bob = await login(deployment, "bob-rest");
    const res = await deployment.fetch(path, { headers: { authorization: `Bearer ${bob}` } });
    expect(res.status).toBe(404);
  });

  it("ends an open stream with an error event once its token expires", async () => {
    const token = await login(deployment, "ann-rest", { ttlMs: 1500 });
    const client = restClient(deployment, token);
    const session = await client.startSession({ project: "alpha" });
    const seen: SseFrame[] = [];
    for await (const f of await openEvents(`/v1/sessions/${session.id}/events`, token))
      seen.push(f);
    expect(seen.at(-1)).toMatchObject({ event: "error" });
    expect(JSON.parse(String(seen.at(-1)?.data))).toMatchObject({ status: 401 });
  });
});
