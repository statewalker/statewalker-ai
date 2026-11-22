// The tracer (statewalker/statewalker-root#121): a user with an access token opens their user
// session, starts an agent session in a project they belong to, and one Flue turn reads a file of
// that project through the gated file view. Run against the harness's own deployment
// (ai-host-do) on CellB Node in-process, with the scripted model.
import { Biscuit, generateKeypair } from "@statewalker/webrun-biscuit";
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
  type Turn,
} from "../src/index.js";

const HOST = new URL("../../ai-host-do/", import.meta.url);
const ADMIN_KEY = "conformance-admin-key";

const FILES = {
  "/alpha/readme.md": "# alpha\nThe tracer reads this.\n",
  "/alpha/.system/access": JSON.stringify({ ann: "reader" }),
  "/beta/notes.md": "beta only\n",
  "/beta/.system/access": JSON.stringify({ bob: "owner" }),
  // A sibling whose name starts with "alpha": not part of alpha.
  "/alphabet/secret.md": "alphabet only\n",
  "/alphabet/.system/access": JSON.stringify({ ann: "owner" }),
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
  });
  await seed(deployment, ADMIN_KEY, FILES);
}, 120_000);
afterAll(async () => {
  for (const s of sockets) s.close();
  await deployment?.close();
  await model?.close();
});

describe.each(transports)("tracer over %s", (_name, connect) => {
  const as = async (user: string) => connect(deployment, await login(deployment, user));

  it("opens the user session with an access token, and a second token resumes the same one", async () => {
    const first = await (await as("ann")).me();
    expect(first).toMatchObject({ user: "ann", workspace: expect.any(String) });
    const second = await (await as("ann")).me();
    expect(second.id).toBe(first.id);
    const other = await (await as("bob")).me();
    expect(other.id).not.toBe(first.id);
  });

  it("refuses a request whose access token the issuer did not sign", async () => {
    const forged = Biscuit.build(
      generateKeypair().secretKey,
      'user("ann");\nworkspace("default");\nissuer("default");\nexpires(9999999999999);',
    ).toBase64();
    await expect((await connect(deployment, forged)).me()).rejects.toMatchObject({ status: 401 });
    await expect((await connect(deployment, "")).me()).rejects.toMatchObject({ status: 401 });
  });

  it("refuses an expired access token", async () => {
    const expired = await login(deployment, "ann", { ttlMs: -1000 });
    await expect((await connect(deployment, expired)).me()).rejects.toMatchObject({ status: 401 });
  });

  it("starts an agent session in a project the user is a member of", async () => {
    const session = await (await as("ann")).startSession({ project: "alpha" });
    expect(session).toMatchObject({ id: expect.any(String), project: "alpha" });
    // The session's capability stays on the server.
    expect(JSON.stringify(session)).not.toMatch(/capability/i);
  });

  it("refuses to start an agent session for a user not in the project's access file", async () => {
    const bob = await as("bob");
    await expect(bob.startSession({ project: "alpha" })).rejects.toMatchObject({
      status: 403,
    });
    const ann = await as("ann");
    await expect(ann.startSession({ project: "beta" })).rejects.toMatchObject({
      status: 403,
    });
    await expect(ann.startSession({ project: "nowhere" })).rejects.toMatchObject({
      status: 403,
    });
  });

  const read = (path: string) => `CALL read ${JSON.stringify({ path })}`;
  const toolResults = (turn: Turn) => turn.items.filter((i) => i.kind === "tool_result");

  it("runs a turn in which Flue's read tool returns a project file through the gate", async () => {
    const ann = await as("ann");
    const session = await ann.startSession({ project: "alpha" });
    const turn = await ann.sendMessage(session.id, { content: read("/alpha/readme.md") });
    expect(turn).toMatchObject({ session: session.id, status: "completed" });
    expect(model.requests.at(-2)?.tools).toContain("read");
    expect(toolResults(turn)).toEqual([
      expect.objectContaining({ name: "read", isError: false, output: FILES["/alpha/readme.md"] }),
    ]);
    expect(turn.items.at(-1)).toMatchObject({
      kind: "message",
      role: "assistant",
      text: `RESULT: ${FILES["/alpha/readme.md"]}`,
    });
    // A relative path is the project's: the session's working directory is /alpha.
    const relative = await ann.sendMessage(session.id, { content: read("readme.md") });
    expect(toolResults(relative)[0]).toMatchObject({ output: FILES["/alpha/readme.md"] });
  });

  it("refuses the read tool a file outside the session's project", async () => {
    const ann = await as("ann");
    const session = await ann.startSession({ project: "alpha" });
    // A project ann is no member of is not there (ENOENT); one she is, but not this session's,
    // is refused (EACCES).
    const outside: Record<string, [string, RegExp]> = {
      "/beta/notes.md": ["beta only", /ENOENT/],
      "../beta/notes.md": ["beta only", /ENOENT/],
      "/alpha/../beta/notes.md": ["beta only", /ENOENT/],
      // ann is an owner there, but this session is alpha's.
      "/alphabet/secret.md": ["alphabet only", /EACCES/],
      "../alphabet/secret.md": ["alphabet only", /EACCES/],
    };
    for (const [path, [content, code]] of Object.entries(outside)) {
      const turn = await ann.sendMessage(session.id, { content: read(path) });
      const [result] = toolResults(turn);
      expect(result).toMatchObject({ name: "read", isError: true });
      expect(result?.output).toMatch(code);
      expect(JSON.stringify(turn)).not.toContain(content);
    }
  });

  it("never lets the read tool see the project's system folder", async () => {
    const ann = await as("ann");
    const session = await ann.startSession({ project: "alpha" });
    for (const path of ["/alpha/.system/access", ".system/access", "/alpha/x/../.system/access"]) {
      const turn = await ann.sendMessage(session.id, { content: read(path) });
      const [result] = toolResults(turn);
      expect(result).toMatchObject({ name: "read", isError: true });
      expect(result?.output).toMatch(/ENOENT/);
      expect(JSON.stringify(turn)).not.toContain("reader");
    }
  });

  it("lists the items of the session's turns, in order", async () => {
    const ann = await as("ann");
    const session = await ann.startSession({ project: "alpha" });
    expect((await ann.listItems(session.id)).items).toEqual([]);
    const turn = await ann.sendMessage(session.id, { content: read("/alpha/readme.md") });
    const { items } = await ann.listItems(session.id);
    expect(items.map((i) => [i.kind, i.role ?? i.name])).toEqual([
      ["message", "user"],
      ["tool_call", "read"],
      ["tool_result", "read"],
      ["message", "assistant"],
    ]);
    expect(items.every((i) => i.turn === turn.id)).toBe(true);
    expect(items.map((i) => i.seq)).toEqual([...items.map((i) => i.seq)].sort((a, b) => a - b));
    expect(items[1]).toMatchObject({ args: { path: "/alpha/readme.md" } });
    expect(items[2]).toMatchObject({ callId: items[1]?.callId, output: FILES["/alpha/readme.md"] });
    const second = await ann.sendMessage(session.id, { content: "hello" });
    const all = (await ann.listItems(session.id)).items;
    expect(all.slice(0, 4)).toEqual(items);
    expect(all.slice(4)).toMatchObject([
      { turn: second.id, kind: "message", role: "user", text: "hello" },
      { turn: second.id, kind: "message", role: "assistant", text: "OK" },
    ]);
  });

  it("refuses to list another user's agent session", async () => {
    const ann = await as("ann");
    const session = await ann.startSession({ project: "alpha" });
    await expect(ann.listItems(session.id)).resolves.toMatchObject({ items: [] });
    await expect((await as("bob")).listItems(session.id)).rejects.toMatchObject({ status: 404 });
  });

  it("refuses a message to another user's agent session", async () => {
    const session = await (await as("ann")).startSession({ project: "alpha" });
    const bob = await as("bob");
    await expect(
      bob.sendMessage(session.id, { content: read("/alpha/readme.md") }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      (await connect(deployment, "")).sendMessage(session.id, { content: "hi" }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("refuses to start an agent session without a valid access token", async () => {
    await expect(
      (await connect(deployment, "")).startSession({ project: "alpha" }),
    ).rejects.toMatchObject({ status: 401 });
  });
});
