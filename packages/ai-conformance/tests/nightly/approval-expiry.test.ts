// Nightly (statewalker/statewalker-root#145, decided in #85): the 24-hour approval expiry, on a
// fake clock. The deployment keeps its default approval time (no APPROVAL_TTL_MS); the scenario
// moves the user's clock forward through the test-only admin route instead of waiting a day.
// Run against the harness's own deployment (ai-host-do) on CellB Node, over REST and RPC.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Approval,
  advanceUserClock,
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
} from "../../src/index.js";

const HOST = new URL("../../../ai-host-do/", import.meta.url);
const ADMIN_KEY = "conformance-admin-key";
const DAY_MS = 24 * 60 * 60 * 1000;

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
  });
  await seed(deployment, ADMIN_KEY, {
    "/proj/readme.md": "# proj\n",
    "/proj/.system/access": JSON.stringify({ "day-rest": "editor", "day-rpc": "editor" }),
  });
}, 120_000);
afterAll(async () => {
  for (const s of sockets) s.close();
  await deployment?.close();
  await model?.close();
});

const call = (tool: string, args: unknown) => `CALL ${tool} ${JSON.stringify(args)}`;
const toolResult = (turn: Turn) => turn.items.find((i) => i.kind === "tool_result");

describe.each(transports)("the 24-hour approval expiry over %s", (name, connect) => {
  const user = `day-${name.toLowerCase()}`;

  it("a pending approval expires after 24 hours on the user's clock and then counts as denied", async () => {
    const client = await connect(deployment, await login(deployment, user));
    const s = await client.startSession({ project: "proj" });
    const turn = await client.sendMessage(s.id, {
      content: call("write", { path: "notes/late.md", content: "late\n" }),
    });
    expect(turn.status).toBe("waiting");
    const id = turn.stop_reason?.approval_ids?.[0];
    const approval = (await client.listApprovals()).approvals.find((a) => a.id === id) as Approval;
    expect(approval.expires - approval.created).toBe(DAY_MS);

    // A second before the day is over, it still waits.
    await advanceUserClock(deployment, ADMIN_KEY, user, DAY_MS - 1000);
    expect((await client.me()).approvals?.map((a) => a.id)).toEqual([approval.id]);

    // Past the day, it has expired: not listed as pending, not answerable, and nothing written.
    await advanceUserClock(deployment, ADMIN_KEY, user, 2000);
    expect((await client.me()).approvals).toEqual([]);
    expect((await client.listApprovals()).approvals).toMatchObject([
      { id: approval.id, status: "expired" },
    ]);
    await expect(
      client.answerApproval(approval.id, { decision: "allow", scope: "once" }),
    ).rejects.toMatchObject({ status: 400 });
    const read = await client.sendMessage(s.id, {
      content: call("read", { path: "notes/late.md" }),
    });
    expect(toolResult(read)?.output).toMatch(/ENOENT/);
  });
});
