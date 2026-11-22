// Agent sessions on Flue's Cloudflare-target runtime (statewalker/statewalker-root#128): each agent
// session is a Flue session of Flue's runtime, hosted by the agent session's own Durable Object,
// on the gated file view. Flue reads the project's AGENTS.md through that view when the session's
// turn initializes; the harness keeps the turns, items and context (Flue's own compaction is off).
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

const FILES = {
  "/fl-alpha/AGENTS.md": "Always answer in the house style of fl-alpha.\n",
  "/fl-alpha/readme.md": "# fl-alpha\n",
  "/fl-alpha/.system/access": JSON.stringify({ ann: "editor", bob: "reader" }),
  "/fl-beta/readme.md": "# fl-beta\n",
  // An AGENTS.md the project's ignore rules hide from agent sessions.
  "/fl-gamma/AGENTS.md": "GAMMA-HIDDEN-INSTRUCTIONS\n",
  "/fl-gamma/.system/ignore": "AGENTS.md\n",
  "/fl-gamma/.system/access": JSON.stringify({ ann: "editor" }),
  "/fl-beta/.system/access": JSON.stringify({ ann: "editor" }),
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
  });
  await seed(deployment, ADMIN_KEY, FILES);
}, 120_000);
afterAll(async () => {
  for (const s of sockets) s.close();
  await deployment?.close();
  await model?.close();
});

describe.each(transports)("Flue's runtime over %s", (name, connect) => {
  const as = async (user: string) => connect(deployment, await login(deployment, user));

  it("reads the project's AGENTS.md through the file view into the model's system prompt", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project: "fl-alpha" });
    const text = `hello flue ${name}`;
    const turn = await ann.sendMessage(s.id, { content: text });
    expect(turn.status).toBe("completed");
    const request = model.requests.find((r) => r.lastUserText === text);
    expect(request?.system).toContain("Always answer in the house style of fl-alpha.");
    // The agent's own instructions come first; the working directory is the project's.
    expect(request?.system).toContain("working in /fl-alpha");
  });

  it("a project without AGENTS.md adds nothing of another project's", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project: "fl-beta" });
    const text = `hello beta ${name}`;
    const turn = await ann.sendMessage(s.id, { content: text });
    expect(turn.status).toBe("completed");
    const request = model.requests.find((r) => r.lastUserText === text);
    expect(request?.system).not.toContain("house style");
  });

  it("reads the workspace context only through the gated file view: an ignored AGENTS.md never reaches the model", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project: "fl-gamma" });
    const text = `hello gamma ${name}`;
    const turn = await ann.sendMessage(s.id, { content: text });
    expect(turn.status).toBe("completed");
    const request = model.requests.find((r) => r.lastUserText === text);
    expect(request?.system).toContain("working in /fl-gamma");
    expect(request?.system).not.toContain("GAMMA-HIDDEN-INSTRUCTIONS");
  });

  it("never offers Flue's own delegation: sub-agents start only through agent_start", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project: "fl-alpha" });
    const text = `tools ${name}`;
    await ann.sendMessage(s.id, { content: text });
    const request = model.requests.find((r) => r.lastUserText === text);
    expect(request?.tools).toEqual(expect.arrayContaining(["read", "write", "bash"]));
    expect(request?.tools).not.toContain("task");
  });

  it("keeps the harness's turns: the second turn's model context is the first turn's items", async () => {
    const bob = await as("bob");
    const s = await bob.startSession({ project: "fl-alpha" });
    const first = `first ${name}`;
    const second = `second ${name}`;
    await bob.sendMessage(s.id, { content: first });
    const turn = await bob.sendMessage(s.id, { content: second });
    expect(turn.status).toBe("completed");
    const request = model.requests.find((r) => r.lastUserText === second);
    // Exactly the harness's items, in order: no Flue narration and no duplicated history.
    expect(request?.messages.filter((m) => m.role !== "system")).toEqual([
      { role: "user", text: first },
      { role: "assistant", text: "OK" },
      { role: "user", text: second },
    ]);
  });
});
