// A restart keeps what the harness holds (statewalker/statewalker-root#146): the behaviour the
// sandbox's flue-capfs-do prototype proved across restarts of its cells, carried over. A deployment
// stopped and started again on its storage still has the files, the sessions and their history,
// the user's mode and the revocations; the access tokens it issued still verify (the issuer's key
// is kept), and a revoked agent session stays refused. Run against the harness's own deployment
// (ai-host-do) with the scripted model, over REST and RPC, where the runtime restarts a deployment
// (CellB Node).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CAN,
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
  sendPastUser,
  startDeployment,
  type Turn,
} from "../src/index.js";

const HOST = new URL("../../ai-host-do/", import.meta.url);
const ADMIN_KEY = "conformance-admin-key";

const enc = new TextEncoder();

type Connect = (deployment: Deployment, token: string) => Promise<SessionClient>;
type OpenFiles = (deployment: Deployment, token: string) => Promise<FilesClient>;
const closers: { close(): void }[] = [];
const keep = <T extends { close(): void }>(c: T) => {
  closers.push(c);
  return c;
};
const transports: [string, Connect, OpenFiles][] = [
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
    MODELS: model.deploymentModels(),
    DEV_LOGIN: "true",
    ADMIN_KEY,
  });
  const files: Record<string, string> = {};
  for (const t of ["rest", "rpc"]) {
    files[`/kept-${t}/readme.md`] = "kept\n";
    files[`/kept-${t}/.system/access`] = JSON.stringify({ [`ann-${t}`]: "owner" });
  }
  await seed(deployment, ADMIN_KEY, files);
}, 120_000);
afterAll(async () => {
  for (const c of closers) c.close();
  await deployment?.close();
  await model?.close();
});

const readBytes = async (files: FilesClient, path: string) => {
  const parts: number[] = [];
  for await (const chunk of files.read(path)) parts.push(...chunk);
  return new Uint8Array(parts);
};
const call = (tool: string, args: unknown) => `CALL ${tool} ${JSON.stringify(args)}`;
const results = (turn: Turn) => turn.items.filter((i) => i.kind === "tool_result");

describe.runIf(CAN.restart).each(transports)("a restart over %s", (t, connect, openFiles) => {
  const T = t.toLowerCase();
  const project = `kept-${T}`;
  const user = `ann-${T}`;

  it("keeps the files, the sessions and their history, the mode and the revocations; issued tokens still verify", async () => {
    const token = await login(deployment, user);
    const ann = await connect(deployment, token);
    const bytes = new Uint8Array(300).map((_, i) => (i * 7) % 256);
    await (await openFiles(deployment, token)).write(`/${project}/data.bin`, [bytes]);
    await ann.setMode({ mode: "acceptEdits" });
    const session = await ann.startSession({ project });
    const before = await ann.sendMessage(session.id, {
      content: call("write", { path: "note.md", content: "written before\n" }),
    });
    expect(results(before)).toEqual([expect.objectContaining({ isError: false })]);
    const doomed = await ann.startSession({ project });
    expect(await ann.revokeSession(doomed.id)).toEqual({ revoked: true });

    for (const c of closers.splice(0)) c.close();
    await deployment.restart?.();

    // The token issued before the restart still opens the same user's session.
    const again = await connect(deployment, token);
    expect((await again.me()).mode).toBe("acceptEdits");
    const files = await openFiles(deployment, token);
    expect(await readBytes(files, `/${project}/data.bin`)).toEqual(bytes);
    // The session carries on with its history.
    const items = (await again.listItems(session.id)).items;
    expect(items.some((i) => i.kind === "tool_result")).toBe(true);
    const after = await again.sendMessage(session.id, {
      content: call("read", { path: "note.md" }),
    });
    expect(results(after)).toEqual([
      expect.objectContaining({ isError: false, output: "written before\n" }),
    ]);
    // The revoked session stays refused, at the User DO and past it, at the gate.
    await expect(
      again.sendMessage(doomed.id, { content: call("read", { path: "readme.md" }) }),
    ).rejects.toMatchObject({ status: 403 });
    const past = await sendPastUser(
      deployment,
      ADMIN_KEY,
      doomed.id,
      call("read", { path: "readme.md" }),
    );
    expect(past).toMatchObject({ status: "failed", error: expect.stringMatching(/EACCES/) });
    expect(results(past)).toEqual([]);
    await again.setMode({ mode: "default" });
    await files.write(`/${project}/after.md`, [enc.encode("after\n")]);
  });
});
