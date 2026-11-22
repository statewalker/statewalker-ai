// Meters, limits and usage records (statewalker/statewalker-root#179, decision #158): limits at the
// deployment (the LIMITS var), workspace (`/.system/limits`, which also holds member limits),
// project (`<project>/.system/limits`), user (their profile's `/limits`, for their own keys) and
// session (the start request's `limits`) levels; the tightest applies, usage is charged to every
// level on its path, and each meter denies its own way. Run against the harness's own deployment
// (ai-host-do) on CellB Node in-process, with the scripted model, over REST and RPC.
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
    [`/sessions-${t}/.system/access`]: owner("ann", "bob"),
    [`/tools-${t}/.system/access`]: owner("ann"),
    [`/tools-${t}/readme.md`]: "README",
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
    ...TRANSPORTS.map((t) => ({ meter: "sessions", level: "member", target: `bob-${t}`, value: 1 })),
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

let model: FakeModel;
let deployment: Deployment;

beforeAll(async () => {
  model = await fakeModel();
  deployment = await startDeployment(HOST, {
    DEV_LOGIN: "true",
    ADMIN_KEY,
    MODELS: model.deploymentModels({
      models: [
        { id: "scripted/default", alias: "default" },
        // One currency unit per output token, at most 10 of them: a request's worst case is 10.
        { id: "scripted/priced", maxTokens: 10, cost: { input: 0, output: 1_000_000 } },
      ],
    }),
  });
  await seed(deployment, ADMIN_KEY, FILES);
}, 120_000);
afterAll(async () => {
  for (const s of sockets) s.close();
  await deployment?.close();
  await model?.close();
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
});
