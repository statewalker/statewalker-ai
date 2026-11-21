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
});
