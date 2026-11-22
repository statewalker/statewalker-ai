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
    MODELS: model.deploymentModels(),
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
});
