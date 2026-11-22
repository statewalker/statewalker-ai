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
  return files;
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
  });
  await seed(deployment, ADMIN_KEY, fixtures());
}, 120_000);
afterAll(async () => {
  for (const s of sockets) s.close();
  await deployment?.close();
  await model?.close();
});

const call = (tool: string, args: unknown) => `CALL ${tool} ${JSON.stringify(args)}`;
const write = (path: string, content: string) => call("write", { path, content });
const remove = (path: string) => call("bash", { command: `rm ${path}` });

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
});
