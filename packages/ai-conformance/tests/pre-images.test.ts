// File pre-images and reverting files on rewind (statewalker/statewalker-root#191, decided in #159):
// the gate keeps, owner-side, the pre-image of every file an agent session (or a sub-agent it
// started) writes, deletes or moves, keyed by session and turn. Rewind, edit and regenerate with
// `revert_files: true` restore each file to its state before the first rewound turn, only where
// nobody changed it since (the others are listed as conflicts and left alone); the revert is a
// `write` under the mode. Pre-images are kept 30 days or 100 MB per session by default, count
// toward the files meter, and are dropped with the session or the project. Run against the
// harness's own deployment (ai-host-do) on CellB Node in-process, with the scripted model, over
// REST and RPC.
import { tryReadText } from "@statewalker/webrun-files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Deployment,
  type FakeModel,
  type FilesClient,
  fakeModel,
  login,
  restClient,
  restFiles,
  rpcClient,
  rpcFiles,
  type SessionClient,
  seed,
  startDeployment,
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

function fixtures(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const t of TRANSPORTS) {
    const editors = JSON.stringify(Object.fromEntries(USERS.map((u) => [`${u}-${t}`, "editor"])));
    for (const u of USERS) files[`/pre-${t}/${u}/readme.md`] = `# ${u}\n`;
    files[`/pre-${t}/.system/access`] = editors;
  }
  // The default workspace keeps up to 100 MB per session (over the deployment's tiny PRE_IMAGES).
  files["/.system/pre-images"] = JSON.stringify({ megabytes: 100 });
  return files;
}

/** The workspace `small-<t>` keeps the deployment's 200 bytes of pre-images per session. */
function smallFixtures(t: string): Record<string, string> {
  const owners = JSON.stringify(Object.fromEntries(USERS.map((u) => [`${u}-${t}`, "owner"])));
  return {
    "/keep/.system/access": owners,
    "/keep/.system/limits": JSON.stringify([
      { meter: "storage_bytes", level: "project", value: 10_000_000 },
    ]),
    "/keep/small.md": "s\n",
    "/keep/big.md": "b".repeat(300),
    "/keep/one.md": "1".repeat(120),
    "/keep/two.md": "2".repeat(120),
    "/keep/meter.md": "m".repeat(40),
  };
}

type Connect = (deployment: Deployment, token: string) => Promise<SessionClient>;
type ConnectFiles = (deployment: Deployment, token: string) => Promise<FilesClient>;
const sockets: { close(): void }[] = [];
const keep = <T extends { close(): void }>(x: T) => {
  sockets.push(x);
  return x;
};
const transports: [string, Connect, ConnectFiles][] = [
  ["REST", async (d, token) => restClient(d, token), async (d, token) => restFiles(d, token)],
  [
    "RPC",
    async (d, token) => keep(await rpcClient(d, token)),
    async (d, token) => keep(await rpcFiles(d, token)),
  ],
];

let model: FakeModel;
let deployment: Deployment;

beforeAll(async () => {
  model = await fakeModel();
  deployment = await startDeployment(HOST, {
    MODELS: model.deploymentModels({
      models: [{ id: "scripted/default", alias: "default" }],
      default: "scripted/default",
    }),
    DEV_LOGIN: "true",
    ADMIN_KEY,
    CATALOG: JSON.stringify(CATALOG),
    WORKSPACES: ["default", ...TRANSPORTS.map((t) => `small-${t}`)].join(","),
    PRE_IMAGES: JSON.stringify({ megabytes: 200 / (1024 * 1024) }),
  });
  await seed(deployment, ADMIN_KEY, fixtures());
  for (const t of TRANSPORTS) await seed(deployment, ADMIN_KEY, smallFixtures(t), `small-${t}`);
}, 120_000);
afterAll(async () => {
  for (const s of sockets) s.close();
  await deployment?.close();
  await model?.close();
});

const call = (tool: string, args: unknown) => `CALL ${tool} ${JSON.stringify(args)}`;
const write = (path: string, content: string) => call("write", { path, content });
const bash = (command: string) => call("bash", { command });

describe.each(transports)("pre-images over %s", (name, connect, connectFiles) => {
  const t = name.toLowerCase();
  const project = `pre-${t}`;
  const as = async (user: string) => {
    const token = await login(deployment, `${user}-${t}`);
    return { api: await connect(deployment, token), files: await connectFiles(deployment, token) };
  };

  it("reverts the files rewound turns wrote, created and deleted to their state before the first of them", async () => {
    const { api, files } = await as("ann");
    await api.setMode({ mode: "bypassPermissions" });
    const dir = `/${project}/ann`;
    const s = await api.startSession({ project });
    const a = await api.sendMessage(s.id, { content: "start" });
    const b = await api.sendMessage(s.id, { content: write(`${dir}/readme.md`, "changed\n") });
    expect(b.status).toBe("completed");
    const c = await api.sendMessage(s.id, { content: write(`${dir}/new.md`, "new\n") });
    expect(c.status).toBe("completed");
    const d = await api.sendMessage(s.id, { content: write(`${dir}/readme.md`, "again\n") });
    expect(d.status).toBe("completed");
    expect(await tryReadText(files, `${dir}/readme.md`)).toBe("again\n");
    const result = await api.rewind(s.id, { to_turn: a.id, revert_files: true });
    expect(result.rewound).toEqual([b.id, c.id, d.id]);
    expect(result.files).toEqual({
      reverted: [`${dir}/new.md`, `${dir}/readme.md`],
      conflicts: [],
      unavailable: [],
    });
    expect(await tryReadText(files, `${dir}/readme.md`)).toBe("# ann\n");
    expect(await files.exists(`${dir}/new.md`)).toBe(false);
  });

  it("asks once in the default mode: the files revert when the user allows it, and stay on a denial", async () => {
    const { api, files } = await as("dee");
    const dir = `/${project}/dee`;
    await api.setMode({ mode: "bypassPermissions" });
    const s = await api.startSession({ project });
    const a = await api.sendMessage(s.id, { content: "start" });
    await api.sendMessage(s.id, { content: write(`${dir}/readme.md`, "one\n") });
    await api.sendMessage(s.id, { content: write(`${dir}/two.md`, "two\n") });
    await api.setMode({ mode: "default" });
    const result = await api.rewind(s.id, { to_turn: a.id, revert_files: true });
    expect(result.head).toBe(a.id);
    const pending = result.files;
    expect(pending).toMatchObject({
      reverted: [],
      conflicts: [],
      unavailable: [],
      pending: [`${dir}/readme.md`, `${dir}/two.md`],
      approval: expect.any(String),
    });
    // Nothing is written before the answer; one approval covers every file.
    expect(await tryReadText(files, `${dir}/readme.md`)).toBe("one\n");
    const listed = (await api.listApprovals()).approvals.filter(
      (x) => x.session === s.id && x.status === "pending",
    );
    expect(listed.map((x) => x.id)).toEqual([pending?.approval]);
    expect(listed[0]?.action).toMatchObject({ method: "revert", path: `/${project}` });
    const answered = await api.answerApproval(String(pending?.approval), {
      decision: "allow",
      scope: "once",
    });
    expect(answered.files).toEqual({
      reverted: [`${dir}/readme.md`, `${dir}/two.md`],
      conflicts: [],
      unavailable: [],
    });
    expect(await tryReadText(files, `${dir}/readme.md`)).toBe("# dee\n");
    expect(await files.exists(`${dir}/two.md`)).toBe(false);
    // A denial leaves the files as they are.
    await api.setMode({ mode: "bypassPermissions" });
    const c = await api.sendMessage(s.id, { content: write(`${dir}/three.md`, "3\n") });
    expect(c.status).toBe("completed");
    await api.setMode({ mode: "default" });
    const again = await api.rewind(s.id, { to_turn: a.id, revert_files: true });
    const denied = await api.answerApproval(String(again.files?.approval), {
      decision: "deny",
      scope: "once",
    });
    expect(denied.files).toMatchObject({
      reverted: [],
      refused: expect.stringContaining("denied"),
    });
    expect(await tryReadText(files, `${dir}/three.md`)).toBe("3\n");
  });

  it("is refused where the mode denies writes, and leaves the files alone", async () => {
    const { api, files } = await as("eli");
    const dir = `/${project}/eli`;
    await api.setMode({ mode: "bypassPermissions" });
    const s = await api.startSession({ project });
    const a = await api.sendMessage(s.id, { content: "start" });
    await api.sendMessage(s.id, { content: write(`${dir}/readme.md`, "one\n") });
    // The project's rules now deny writes there.
    await seed(deployment, ADMIN_KEY, {
      [`/${project}/.system/permission-rules`]: JSON.stringify({ deny: ["files.write:/eli/**"] }),
    });
    const result = await api.rewind(s.id, { to_turn: a.id, revert_files: true });
    expect(result.files).toMatchObject({ reverted: [], refused: expect.any(String) });
    expect(await tryReadText(files, `${dir}/readme.md`)).toBe("one\n");
  });

  it("reverts the files a sub-agent started by a rewound turn changed", async () => {
    const { api, files } = await as("fay");
    await api.setMode({ mode: "bypassPermissions" });
    const dir = `/${project}/fay`;
    const s = await api.startSession({ project, agent: "team/lead" });
    const a = await api.sendMessage(s.id, { content: "plan" });
    const started = await api.sendMessage(s.id, {
      content: call("agent_start", {
        agent: "team/helper",
        message: write(`${dir}/readme.md`, "helper\n"),
      }),
    });
    expect(started.status).toBe("completed");
    expect(await tryReadText(files, `${dir}/readme.md`)).toBe("helper\n");
    const result = await api.rewind(s.id, { to_turn: a.id, revert_files: true });
    expect(result.stopped_children).toHaveLength(1);
    expect(result.files).toEqual({
      reverted: [`${dir}/readme.md`],
      conflicts: [],
      unavailable: [],
    });
    expect(await tryReadText(files, `${dir}/readme.md`)).toBe("# fay\n");
  });

  it("reverts on edit and regenerate too; a branch switch never touches files", async () => {
    const { api, files } = await as("gus");
    await api.setMode({ mode: "bypassPermissions" });
    const dir = `/${project}/gus`;
    const s = await api.startSession({ project });
    await api.sendMessage(s.id, { content: "start" });
    const b = await api.sendMessage(s.id, { content: write(`${dir}/readme.md`, "b\n") });
    const edited = await api.editTurn(b.id, {
      content: write(`${dir}/other.md`, "e\n"),
      revert_files: true,
    });
    expect(edited.rewind.files).toEqual({
      reverted: [`${dir}/readme.md`],
      conflicts: [],
      unavailable: [],
    });
    const e = await api.waitTurn(edited);
    expect(e.status).toBe("completed");
    expect(await tryReadText(files, `${dir}/readme.md`)).toBe("# gus\n");
    expect(await tryReadText(files, `${dir}/other.md`)).toBe("e\n");
    // Switching back to b's branch leaves the files as they are.
    await api.setHead(s.id, { turn: b.id });
    expect(await tryReadText(files, `${dir}/readme.md`)).toBe("# gus\n");
    expect(await tryReadText(files, `${dir}/other.md`)).toBe("e\n");
    await api.setHead(s.id, { turn: e.id });
    const regenerated = await api.regenerateTurn(e.id, { revert_files: true });
    expect(regenerated.rewind.files).toEqual({
      reverted: [`${dir}/other.md`],
      conflicts: [],
      unavailable: [],
    });
    // The regenerated turn writes it again.
    expect((await api.waitTurn(regenerated)).status).toBe("completed");
    expect(await tryReadText(files, `${dir}/other.md`)).toBe("e\n");
  });

  it("reverts deletions and moves, a folder's files included", async () => {
    const { api, files } = await as("hal");
    await api.setMode({ mode: "bypassPermissions" });
    const dir = `/${project}/hal`;
    await files.write(`${dir}/box/one.md`, [new TextEncoder().encode("1\n")]);
    await files.write(`${dir}/box/two.md`, [new TextEncoder().encode("2\n")]);
    const s = await api.startSession({ project });
    const a = await api.sendMessage(s.id, { content: "start" });
    const moved = await api.sendMessage(s.id, {
      content: bash(`mv ${dir}/readme.md ${dir}/moved.md`),
    });
    expect(moved.items.find((i) => i.kind === "tool_result")).toMatchObject({ isError: false });
    const removed = await api.sendMessage(s.id, { content: bash(`rm -r ${dir}/box`) });
    expect(removed.items.find((i) => i.kind === "tool_result")).toMatchObject({ isError: false });
    expect(await files.exists(`${dir}/box/one.md`)).toBe(false);
    const result = await api.rewind(s.id, { to_turn: a.id, revert_files: true });
    expect(result.files).toEqual({
      reverted: [`${dir}/box/one.md`, `${dir}/box/two.md`, `${dir}/moved.md`, `${dir}/readme.md`],
      conflicts: [],
      unavailable: [],
    });
    expect(await tryReadText(files, `${dir}/readme.md`)).toBe("# hal\n");
    expect(await files.exists(`${dir}/moved.md`)).toBe(false);
    expect(await tryReadText(files, `${dir}/box/one.md`)).toBe("1\n");
    expect(await tryReadText(files, `${dir}/box/two.md`)).toBe("2\n");
  });

  it("keeps pre-images out of every file view: neither the agent nor the user sees them", async () => {
    const { api, files } = await as("ivy");
    await api.setMode({ mode: "bypassPermissions" });
    const dir = `/${project}/ivy`;
    const s = await api.startSession({ project });
    await api.sendMessage(s.id, { content: write(`${dir}/readme.md`, "kept\n") });
    const seen: string[] = [];
    for await (const e of files.list("/", { recursive: true }))
      if (e.kind === "file" && !e.path.startsWith(`/${project}/`)) seen.push(e.path);
    expect(seen.filter((p) => /pre|image/i.test(p))).toEqual([]);
    const own: string[] = [];
    for await (const e of files.list(dir, { recursive: true })) own.push(e.path);
    expect(own).toEqual([`${dir}/readme.md`]);
    const listed = await api.sendMessage(s.id, { content: bash("ls -aR /") });
    const output = String(listed.items.find((i) => i.kind === "tool_result")?.output ?? "");
    expect(output).not.toMatch(/pre.?image/i);
  });

  it("leaves the files someone changed since alone and lists them as conflicts", async () => {
    const { api, files } = await as("bob");
    await api.setMode({ mode: "bypassPermissions" });
    const dir = `/${project}/bob`;
    const s = await api.startSession({ project });
    const a = await api.sendMessage(s.id, { content: write(`${dir}/x.md`, "x0\n") });
    await api.sendMessage(s.id, { content: write(`${dir}/x.md`, "x1\n") });
    await api.sendMessage(s.id, { content: write(`${dir}/readme.md`, "agent\n") });
    await api.sendMessage(s.id, { content: write(`${dir}/y.md`, "y\n") });
    // The user edits one file; a later turn kept on the path edits another.
    await files.write(`${dir}/readme.md`, [new TextEncoder().encode("user\n")]);
    const result = await api.rewind(s.id, { to_turn: a.id, revert_files: true });
    expect(result.files).toEqual({
      reverted: [`${dir}/x.md`, `${dir}/y.md`],
      conflicts: [`${dir}/readme.md`],
      unavailable: [],
    });
    expect(await tryReadText(files, `${dir}/x.md`)).toBe("x0\n");
    expect(await files.exists(`${dir}/y.md`)).toBe(false);
    expect(await tryReadText(files, `${dir}/readme.md`)).toBe("user\n");
  });

  it("counts a later turn's change on another branch as a change since", async () => {
    const { api, files } = await as("cy");
    await api.setMode({ mode: "bypassPermissions" });
    const dir = `/${project}/cy`;
    const s = await api.startSession({ project });
    const a = await api.sendMessage(s.id, { content: "start" });
    const b = await api.sendMessage(s.id, { content: write(`${dir}/readme.md`, "b\n") });
    // Rewound without reverting: a sibling turn writes the same file again.
    await api.rewind(s.id, { to_turn: a.id });
    await api.sendMessage(s.id, { content: write(`${dir}/readme.md`, "c\n") });
    // Back on b's branch (no file is touched), then rewound with the revert: b's file changed since.
    const back = await api.setHead(s.id, { turn: b.id });
    expect(back.files).toBeUndefined();
    expect(await tryReadText(files, `${dir}/readme.md`)).toBe("c\n");
    const result = await api.rewind(s.id, { to_turn: a.id, revert_files: true });
    expect(result.files).toEqual({
      reverted: [],
      conflicts: [`${dir}/readme.md`],
      unavailable: [],
    });
    expect(await tryReadText(files, `${dir}/readme.md`)).toBe("c\n");
  });
});

describe.each(transports)("pre-images' retention over %s", (name, connect, connectFiles) => {
  const t = name.toLowerCase();
  const workspace = `small-${t}`;
  const as = async (user: string) => {
    const token = await login(deployment, `${user}-${t}`, { workspace });
    const api = await connect(deployment, token);
    await api.setMode({ mode: "bypassPermissions" });
    return { api, files: await connectFiles(deployment, token) };
  };
  const used = async (api: SessionClient) =>
    (await api.effectiveLimits({ project: "keep" })).limits.find(
      (l) => l.meter === "storage_bytes" && l.level === "project",
    )?.used;

  it("keeps no pre-image larger than the retention, and drops the oldest past it: those files are reported", async () => {
    const { api, files } = await as("ann");
    const s = await api.startSession({ project: "keep" });
    const a = await api.sendMessage(s.id, { content: "start" });
    await api.sendMessage(s.id, { content: write("/keep/big.md", "B\n") });
    await api.sendMessage(s.id, { content: write("/keep/one.md", "1\n") });
    await api.sendMessage(s.id, { content: write("/keep/small.md", "S\n") });
    // 120 + 3 + 120 bytes is over the 200 kept per session: the oldest, one.md's, goes.
    await api.sendMessage(s.id, { content: write("/keep/two.md", "2\n") });
    const result = await api.rewind(s.id, { to_turn: a.id, revert_files: true });
    expect(result.files).toEqual({
      reverted: ["/keep/small.md", "/keep/two.md"],
      conflicts: [],
      unavailable: ["/keep/big.md", "/keep/one.md"],
    });
    expect(await tryReadText(files, "/keep/small.md")).toBe("s\n");
    expect(await tryReadText(files, "/keep/big.md")).toBe("B\n");
    expect(await tryReadText(files, "/keep/one.md")).toBe("1\n");
  });

  it("counts pre-images toward the files meter, and drops them when the session is archived", async () => {
    const { api } = await as("bob");
    const before = Number(await used(api));
    const s = await api.startSession({ project: "keep" });
    await api.sendMessage(s.id, { content: write("/keep/meter.md", "n".repeat(50)) });
    // The file grew by 10 bytes, and its 40-byte pre-image is kept.
    expect(await used(api)).toBe(before + 10 + 40);
    await api.archiveSession(s.id);
    expect(await used(api)).toBe(before + 10);
  });

  it("drops a deleted session's pre-images: a fork records the checkpoint it started from", async () => {
    const { api } = await as("cy");
    const s = await api.startSession({ project: "keep" });
    const a = await api.sendMessage(s.id, { content: "start" });
    const { session: plain } = await api.forkSession(s.id, { at_turn: a.id });
    // Nothing kept yet: no checkpoint.
    expect(plain.forked_from).toEqual({ session: s.id, turn: a.id });
    const b = await api.sendMessage(s.id, { content: write("/keep/small.md", "x\n") });
    const { session: fork } = await api.forkSession(s.id, { at_turn: b.id });
    expect(fork.forked_from).toEqual({
      session: s.id,
      turn: b.id,
      checkpoint: expect.stringMatching(/^pi-\d+$/),
    });
    expect((await api.getSession(fork.id)).forked_from).toEqual(fork.forked_from);
    const before = Number(await used(api));
    await api.deleteSession(s.id);
    expect(await used(api)).toBe(before - 2);
  });
});
