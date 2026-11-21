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
  seed,
  startDeployment,
} from "../src/index.js";

const HOST = new URL("../../ai-host-do/", import.meta.url);
const ADMIN_KEY = "conformance-admin-key";
const TRANSPORTS = ["rest", "rpc"];

const FILES = {
  "/alpha/readme.md": "# alpha\n",
  "/alpha/.system/access": JSON.stringify(
    Object.fromEntries(TRANSPORTS.flatMap((t) => [[`ann-${t}`, "editor"], [`bob-${t}`, "reader"]])),
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
    LLM_BASE_URL: model.url,
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
    const session = await ann.startSession({ project: "alpha", agent: "a" });
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
    const session = await ann.startSession({ project: "alpha", agent: "a" });
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
    const session = await ann.startSession({ project: "alpha", agent: "a" });
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
    const session = await ann.startSession({ project: "alpha", agent: "a" });
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
});
