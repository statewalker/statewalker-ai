// The workspace store as a holder sees it (statewalker/statewalker-root#146): the behaviours the
// sandbox's flue-capfs-do prototype proved of its store, carried over to the harness. File content
// crosses every path byte for byte (NUL bytes, non-ASCII text, every byte value); paths are
// case-sensitive, rights included; the shell's cp and mv onto a file and into a folder behave as
// POSIX says; appends from parallel sessions lose nothing. Run against the harness's own deployment
// (ai-host-do) with the scripted model, over REST and RPC.
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
  setAccess,
  startDeployment,
  type Turn,
} from "../src/index.js";

const HOST = new URL("../../ai-host-do/", import.meta.url);
const ADMIN_KEY = "conformance-admin-key";

const enc = new TextEncoder();
const dec = new TextDecoder();

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
    ROLE_SOURCES: "sql,file",
  });
  const files: Record<string, string> = {};
  for (const t of ["rest", "rpc"]) {
    files[`/store-${t}/readme.md`] = "store\n";
    files[`/store-${t}/.system/access`] = JSON.stringify({ ann: "owner", bob: "editor" });
    files[`/cases-${t}/.system/access`] = JSON.stringify({});
  }
  await seed(deployment, ADMIN_KEY, files);
}, 120_000);
afterAll(async () => {
  for (const c of closers) c.close();
  await deployment?.close();
  await model?.close();
});

const readBytes = async (files: FilesClient, path: string) => {
  const parts: Uint8Array[] = [];
  for await (const chunk of files.read(path)) parts.push(chunk);
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return all;
};
const readText = async (files: FilesClient, path: string) =>
  dec.decode(await readBytes(files, path));
const call = (tool: string, args: unknown) => `CALL ${tool} ${JSON.stringify(args)}`;
const toolResult = (turn: Turn) => turn.items.find((i) => i.kind === "tool_result");

// Every byte value, twice, with NUL first: what text decoding or C strings would lose.
const ALL_BYTES = new Uint8Array(512).map((_, i) => i % 256);
const TEXT = "nul\u0000inside — ünïcödé 日本語 🙂 and a lone \r\n end\n";

describe.each(transports)("the store over %s", (t, connect, openFiles) => {
  const T = t.toLowerCase();
  const project = `store-${T}`;
  const cases = `cases-${T}`;
  const as = async (user: string) => connect(deployment, await login(deployment, user));
  const filesOf = async (user: string) => openFiles(deployment, await login(deployment, user));
  const agent = async (user: string, p = project) => {
    const client = await as(user);
    await client.setMode({ mode: "bypassPermissions" });
    const session = await client.startSession({ project: p });
    return {
      run: async (tool: string, args: unknown) =>
        toolResult(await client.sendMessage(session.id, { content: call(tool, args) })),
    };
  };

  it("keeps file content byte for byte: NUL bytes, non-ASCII text and every byte value, through the user's view and an agent's tools", async () => {
    const ann = await filesOf("ann");
    await ann.write(`/${project}/all.bin`, [ALL_BYTES]);
    await ann.write(`/${project}/text.txt`, [enc.encode(TEXT)]);
    expect(await readBytes(ann, `/${project}/all.bin`)).toEqual(ALL_BYTES);
    expect(await ann.stats(`/${project}/all.bin`)).toMatchObject({ size: ALL_BYTES.length });
    expect(await readText(ann, `/${project}/text.txt`)).toBe(TEXT);
    // The agent's shell copies and appends bytes, never text it decoded and encoded again.
    const a = await agent("ann");
    const sh = await a.run("bash", {
      command:
        "cp all.bin copy.bin && cat all.bin all.bin > twice.bin && cat text.txt >> text-copy.txt",
    });
    expect(sh).toMatchObject({ isError: false });
    expect(await readBytes(ann, `/${project}/copy.bin`)).toEqual(ALL_BYTES);
    const twice = new Uint8Array(ALL_BYTES.length * 2);
    twice.set(ALL_BYTES);
    twice.set(ALL_BYTES, ALL_BYTES.length);
    const got = await readBytes(ann, `/${project}/twice.bin`);
    expect(got.length).toBe(twice.length);
    expect(got).toEqual(twice);
    expect(await readText(ann, `/${project}/text-copy.txt`)).toBe(TEXT);
    // The agent's read tool shows the text whole, NUL and all.
    const read = await a.run("read", { path: "text.txt" });
    expect(read?.output).toContain("ünïcödé 日本語 🙂");
    expect(read?.output).toContain("nul\u0000inside");
  });

  it("is case-sensitive: rights on /HR never reach /hr, nor files on one spelling the other", async () => {
    await setAccess(deployment, ADMIN_KEY, {
      project: cases,
      roles: { hr: ["files.list", "files.read:/HR/**", "files.write:/HR/**"] },
      members: { ann: ["owner"], hal: ["hr"] },
    });
    const ann = await filesOf("ann");
    await ann.write(`/${cases}/HR/pay.txt`, [enc.encode("upper\n")]);
    await ann.write(`/${cases}/hr/pay.txt`, [enc.encode("lower\n")]);
    expect(await readText(ann, `/${cases}/HR/pay.txt`)).toBe("upper\n");
    expect(await readText(ann, `/${cases}/hr/pay.txt`)).toBe("lower\n");
    expect(await ann.exists(`/${cases}/Hr/pay.txt`)).toBe(false);
    const hal = await filesOf("hal");
    expect(await readText(hal, `/${cases}/HR/pay.txt`)).toBe("upper\n");
    await expect(readText(hal, `/${cases}/hr/pay.txt`)).rejects.toThrow(/EACCES|ENOENT/);
    await expect(hal.write(`/${cases}/hr/pay.txt`, [enc.encode("x")])).rejects.toThrow(
      /EACCES|ENOENT/,
    );
    // Removing the lower-case folder with the shell leaves the upper-case one alone.
    const a = await agent("ann", cases);
    expect(await a.run("bash", { command: "rm -r hr" })).toMatchObject({ isError: false });
    expect(await ann.exists(`/${cases}/hr/pay.txt`)).toBe(false);
    expect(await readText(ann, `/${cases}/HR/pay.txt`)).toBe("upper\n");
  });

  it("copies and moves with the shell onto an existing file, replacing it, and into a folder, by name", async () => {
    const ann = await filesOf("ann");
    await ann.write(`/${project}/src.txt`, [enc.encode("source\n")]);
    await ann.write(`/${project}/dst.txt`, [enc.encode("old target\n")]);
    await ann.write(`/${project}/dir/keep.txt`, [enc.encode("keep\n")]);
    const a = await agent("ann");
    const sh = await a.run("bash", {
      command: "cp src.txt dst.txt && cp src.txt dir && mv dst.txt moved.txt && mv moved.txt dir",
    });
    expect(sh, sh?.output).toMatchObject({ isError: false });
    expect(await ann.exists(`/${project}/dst.txt`)).toBe(false);
    expect(await readText(ann, `/${project}/src.txt`)).toBe("source\n");
    expect(await readText(ann, `/${project}/dir/src.txt`)).toBe("source\n");
    expect(await readText(ann, `/${project}/dir/moved.txt`)).toBe("source\n");
    expect(await readText(ann, `/${project}/dir/keep.txt`)).toBe("keep\n");
  });

  it("loses no append when sessions of two users append to one file in parallel", async () => {
    const ann = await filesOf("ann");
    await ann.write(`/${project}/log.txt`, [new Uint8Array()]);
    const N = 12;
    const lines = (who: string) =>
      Array.from({ length: N }, (_, i) => `echo ${who}-${i} >> log.txt`).join("; ");
    const [x, y] = await Promise.all([agent("ann"), agent("bob")]);
    const results = await Promise.all([
      x.run("bash", { command: lines("ann") }),
      y.run("bash", { command: lines("bob") }),
    ]);
    for (const r of results) expect(r).toMatchObject({ isError: false });
    const got = (await readText(ann, `/${project}/log.txt`)).split("\n").filter(Boolean);
    const want = [
      ...Array.from({ length: N }, (_, i) => `ann-${i}`),
      ...Array.from({ length: N }, (_, i) => `bob-${i}`),
    ];
    expect([...got].sort()).toEqual([...want].sort());
    // Each session's own lines stay in its order.
    expect(got.filter((l) => l.startsWith("ann-"))).toEqual(want.slice(0, N));
  });

  it("asks about an append in default mode as an append: approving adds exactly those bytes, once", async () => {
    const ann = await filesOf("ann");
    await ann.write(`/${project}/asked.txt`, [enc.encode("first\n")]);
    const bob = await as("bob");
    await bob.setMode({ mode: "default" });
    const s = await bob.startSession({ project });
    const turn = await bob.sendMessage(s.id, {
      content: call("bash", { command: "echo second >> asked.txt" }),
    });
    expect(turn.status).toBe("waiting");
    const id = turn.stop_reason?.approval_ids?.[0];
    const approval = (await bob.listApprovals()).approvals.find((a) => a.id === id);
    expect(approval?.action).toMatchObject({ method: "append", path: `/${project}/asked.txt` });
    // Someone else writes meanwhile: the approved append lands after it, replacing nothing.
    await ann.write(`/${project}/asked.txt`, [enc.encode("first\nmeanwhile\n")]);
    const { accepted } = await bob.answerApproval(String(id), { decision: "allow", scope: "once" });
    const done = await bob.waitTurn(accepted);
    expect(done.status).toBe("completed");
    expect(await readText(ann, `/${project}/asked.txt`)).toBe("first\nmeanwhile\nsecond\n");
  });
});

describe("the test-only admin routes", () => {
  const seedWith = (d: Deployment, key?: string) =>
    d.fetch("/admin/seed", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({ files: { "/store-rest/planted.md": "planted\n" } }),
    });

  it("answer only the deployment's ADMIN_KEY, and are not there without one", async () => {
    for (const key of [undefined, "wrong-key", await login(deployment, "ann")]) {
      const res = await seedWith(deployment, key);
      expect(res.ok).toBe(false);
    }
    expect(
      await restFiles(deployment, await login(deployment, "ann")).exists("/store-rest/planted.md"),
    ).toBe(false);
    const bare = await startDeployment(HOST, {
      MODELS: model.deploymentModels(),
      DEV_LOGIN: "true",
    });
    try {
      for (const key of [undefined, ADMIN_KEY, ""]) {
        const res = await seedWith(bare, key);
        expect(res.ok).toBe(false);
      }
    } finally {
      await bare.close();
    }
  });
});
