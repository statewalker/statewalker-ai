// The complete file view (statewalker/statewalker-root#122, decided in #80): a holder sees the
// projects of its user at `/`, never a system folder, and, in agent sessions, never a file the
// ignore rules name; every holder's FilesApi is a files-RPC client of the gate, with chunked
// streams re-authorized block by block. The user's own session reaches its file view through the
// session API (REST under /v1/files, files-RPC on the WebSocket at /v1/files); agent sessions
// through their tools. Run against the harness's own deployment (ai-host-do) on CellB Node
// in-process, with the scripted model, over REST and RPC.
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
  setAccess,
  startDeployment,
  type Turn,
  workspaceBackend,
} from "../src/index.js";

const HOST = new URL("../../ai-host-do/", import.meta.url);
const ADMIN_KEY = "conformance-admin-key";
const BLOCK = 1024;
const BIG = 64 * BLOCK;

const enc = new TextEncoder();
const dec = new TextDecoder();

// Each transport gets its own projects, so what one run changes never reaches the other.
function fixtures(t: string): Record<string, string> {
  return {
    [`/alpha-${t}/readme.md`]: "# alpha\n",
    [`/alpha-${t}/docs/guide.md`]: "the guide\n",
    [`/alpha-${t}/docs/.env`]: "TOKEN=deployment-ignored\n",
    [`/alpha-${t}/build/out.js`]: "built output\n",
    [`/alpha-${t}/debug.log`]: "log noise\n",
    [`/alpha-${t}/.system/access`]: JSON.stringify({ ann: "owner", rex: "reader" }),
    [`/alpha-${t}/.system/ignore`]: "build/\n*.log\n",
    [`/beta-${t}/notes.md`]: "beta only\n",
    [`/beta-${t}/.system/access`]: JSON.stringify({ bob: "owner" }),
    [`/gamma-${t}/keep.md`]: "keep\n",
    [`/gamma-${t}/docs/a.md`]: "a\n",
    [`/gamma-${t}/.system/access`]: JSON.stringify({ ann: "owner" }),
    [`/stream-${t}/.system/access`]: JSON.stringify({}),
  };
}

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
    IGNORE: ".env\n",
    FILE_BLOCK_SIZE: String(BLOCK),
  });
  await seed(deployment, ADMIN_KEY, { ...fixtures("rest"), ...fixtures("rpc") });
}, 120_000);
afterAll(async () => {
  for (const c of closers) c.close();
  await deployment?.close();
  await model?.close();
});

const readText = async (files: FilesClient, path: string) => {
  let text = "";
  for await (const chunk of files.read(path)) text += dec.decode(chunk, { stream: true });
  return text;
};
const listAll = async (files: FilesClient, path: string, recursive = true) => {
  const paths: string[] = [];
  for await (const e of files.list(path, { recursive })) paths.push(e.path);
  return paths.sort();
};
const call = (tool: string, args: unknown) => `CALL ${tool} ${JSON.stringify(args)}`;
const toolResult = (turn: Turn) => turn.items.find((i) => i.kind === "tool_result");

describe.each(transports)("the file view over %s", (t, connect, openFiles) => {
  const T = t.toLowerCase();
  const alpha = `alpha-${T}`;
  const beta = `beta-${T}`;
  const gamma = `gamma-${T}`;
  const as = async (user: string) => connect(deployment, await login(deployment, user));
  const filesOf = async (user: string) => openFiles(deployment, await login(deployment, user));
  const agent = async (user: string, project: string) => {
    const client = await as(user);
    const session = await client.startSession({ project });
    return {
      run: async (tool: string, args: unknown) =>
        toolResult(await client.sendMessage(session.id, { content: call(tool, args) })),
    };
  };

  it("shows at / only the projects the user is a member of, in the user's own session", async () => {
    const ann = await filesOf("ann");
    const top = await listAll(ann, "/", false);
    expect(top).toContain(`/${alpha}`);
    expect(top).toContain(`/${gamma}`);
    expect(top).not.toContain(`/${beta}`);
    expect(top.some((p) => p.startsWith("/.system"))).toBe(false);
    expect(await ann.stats(`/${beta}/notes.md`)).toBeUndefined();
    expect(await readText(ann, `/${beta}/notes.md`)).toBe("");
    expect(await readText(ann, `/${alpha}/readme.md`)).toBe("# alpha\n");
  });

  it("works in its project in an agent session, which sees no other project at /", async () => {
    const a = await agent("ann", alpha);
    expect((await a.run("bash", { command: "pwd" }))?.output).toMatch(
      new RegExp(`^/${alpha}\\s*$`),
    );
    const top = (await a.run("bash", { command: "ls -a /" }))?.output ?? "";
    expect(top).toContain(alpha);
    expect(top).not.toContain(beta);
    expect(top).not.toContain(gamma);
    const other = await a.run("read", { path: `/${beta}/notes.md` });
    expect(other).toMatchObject({ isError: true });
    expect(other?.output).toMatch(/ENOENT/);
  });

  it("never shows the system folder to the user's own session, under any path form", async () => {
    const ann = await filesOf("ann");
    expect((await listAll(ann, `/${alpha}`)).some((p) => p.includes(".system"))).toBe(false);
    for (const path of [
      `/${alpha}/.system/access`,
      `/${alpha}/./.system/access`,
      `/${alpha}/docs/../.system/access`,
      `//${alpha}//.system//access`,
      `/${alpha}/.SYSTEM/access`,
      `/${alpha}/.system`,
      `/../${alpha}/.system/access`,
    ]) {
      expect(await ann.stats(path)).toBeUndefined();
      expect(await ann.exists(path)).toBe(false);
      expect(await readText(ann, path)).toBe("");
      expect(await listAll(ann, path)).toEqual([]);
      expect(await ann.remove(path)).toBe(false);
      await expect(ann.write(path, [enc.encode("{}")])).rejects.toThrow(/ENOENT/);
    }
    // Copying or moving the system folder finds nothing; nothing lands in it.
    expect(await ann.copy(`/${alpha}/.system`, `/${alpha}/stolen`)).toBe(false);
    expect(await ann.move(`/${alpha}/.system/access`, `/${alpha}/stolen`)).toBe(false);
    await expect(ann.copy(`/${alpha}/readme.md`, `/${alpha}/.system/access`)).rejects.toThrow(
      /ENOENT/,
    );
    expect(await ann.exists(`/${alpha}/stolen`)).toBe(false);
    // The access file is intact: rex still reads alpha.
    expect(await readText(await filesOf("rex"), `/${alpha}/readme.md`)).toBe("# alpha\n");
  });

  it("removes, copies and moves a project's files but never its system folder", async () => {
    const ann = await filesOf("ann");
    // A copy elsewhere carries no system folder (at that depth it would be an ordinary folder).
    expect(await ann.copy(`/${gamma}`, `/${gamma}/../${alpha}/gamma-copy`)).toBe(true);
    expect(await listAll(ann, `/${alpha}/gamma-copy`)).toEqual([
      `/${alpha}/gamma-copy/docs`,
      `/${alpha}/gamma-copy/docs/a.md`,
      `/${alpha}/gamma-copy/keep.md`,
    ]);
    expect(await ann.move(`/${gamma}/docs`, `/${gamma}/moved`)).toBe(true);
    expect(await readText(ann, `/${gamma}/moved/a.md`)).toBe("a\n");
    // rm -r of the whole project: its files go, its system folder stays.
    expect(await ann.remove(`/${gamma}`)).toBe(true);
    expect(await listAll(ann, `/${gamma}`)).toEqual([]);
    expect(await listAll(ann, "/", false)).toContain(`/${gamma}`);
    await writeBack(ann, `/${gamma}/keep.md`);
    expect(await readText(ann, `/${gamma}/keep.md`)).toBe("keep again\n");
  });

  it("refuses an encoded path form of the system folder over REST", async () => {
    const token = await login(deployment, "ann");
    for (const path of [
      `/v1/files/${alpha}/%2Esystem/access`,
      `/v1/files/${alpha}%2F.system%2Faccess`,
      `/v1/files/${alpha}/docs/%2E%2E/.system/access`,
      `/v1/files/${alpha}/%2e%53YSTEM/access`,
      `/v1/files/${alpha}%2F..%2F${alpha}%2F.system%2Faccess`,
      `/v1/files/${alpha}%2F..%2F..%2F${beta}%2Fnotes.md`,
    ]) {
      const res = await deployment.fetch(path, { headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(404);
      expect(await res.text()).not.toMatch(/owner|beta only/);
    }
  });

  it("never lets an agent's tools see or change the system folder: readdir, glob, rm -r, cp, mv", async () => {
    // The view is under test, not the mode: a mode that never asks lets every change reach it.
    await (await as("ann")).setMode({ mode: "bypassPermissions" });
    const a = await agent("ann", alpha);
    const ls = await a.run("bash", { command: `ls -a /${alpha}` });
    expect(ls?.output).toContain("readme.md");
    expect(ls?.output).not.toContain(".system");
    const glob = await a.run("glob", { pattern: "*" });
    expect(glob?.output).toContain("guide.md");
    expect(glob?.output).not.toContain(".system");
    for (const pattern of ["access", ".sys*", "*ignore*"])
      expect((await a.run("glob", { pattern, path: "/" }))?.output).not.toMatch(/\.system|access/);
    const star = await a.run("bash", { command: `echo /${alpha}/.sys* /${alpha}/.SYS*` });
    expect(star?.output).not.toMatch(/\.system\/|access/);
    const cat = await a.run("bash", { command: `cat /${alpha}/.system/access` });
    expect(cat?.output).not.toContain("owner");
    const steal = await a.run("bash", {
      command: `cp -r /${alpha}/.system /${alpha}/stolen; mv /${alpha}/.system /${alpha}/moved; cp /${alpha}/readme.md /${alpha}/.system/access; ls /${alpha}`,
    });
    expect(steal?.output).not.toMatch(/stolen|moved/);
    await a.run("bash", {
      command: `cp -r /${alpha} /${alpha}/docs-copy 2>&1; rm -rf /${alpha}/docs`,
    });
    const ann = await filesOf("ann");
    expect(await ann.exists(`/${alpha}/docs/guide.md`)).toBe(false);
    expect(await ann.exists(`/${alpha}/stolen`)).toBe(false);
    // The access file is intact: rex still reads alpha.
    expect(await readText(await filesOf("rex"), `/${alpha}/readme.md`)).toBe("# alpha\n");
    await ann.write(`/${alpha}/docs/guide.md`, [enc.encode("the guide\n")]);
    await ann.write(`/${alpha}/docs/.env`, [enc.encode("TOKEN=deployment-ignored\n")]);
    await (await as("ann")).setMode({ mode: "default" });
  });

  it("hides files the ignore rules name from agent sessions, but not from the user's own session", async () => {
    const ann = await filesOf("ann");
    expect(await readText(ann, `/${alpha}/build/out.js`)).toBe("built output\n");
    expect(await readText(ann, `/${alpha}/debug.log`)).toBe("log noise\n");
    expect(await readText(ann, `/${alpha}/docs/.env`)).toBe("TOKEN=deployment-ignored\n");
    const a = await agent("ann", alpha);
    for (const path of [`/${alpha}/build/out.js`, "debug.log", "docs/.env"]) {
      const r = await a.run("read", { path });
      expect(r).toMatchObject({ isError: true });
      expect(r?.output).toMatch(/ENOENT/);
    }
    const ls = (await a.run("bash", { command: "ls -a . docs" }))?.output ?? "";
    expect(ls).toContain("readme.md");
    expect(ls).not.toMatch(/build|debug\.log|\.env/);
    const grep = (await a.run("grep", { pattern: "deployment-ignored|built output|log noise" }))
      ?.output;
    expect(grep).not.toMatch(/deployment-ignored|built output|log noise/);
  });

  it("stops a stream at the next block once the user's access is revoked", async () => {
    const project = `stream-${T}`;
    await setAccess(deployment, ADMIN_KEY, { project, members: { ann: ["editor"] } });
    const ann = await filesOf("ann");
    await ann.write(`/${project}/big.bin`, [new Uint8Array(BIG).fill(9)]);
    expect((await ann.stats(`/${project}/big.bin`))?.kind).toBe("file");
    const it = ann.read(`/${project}/big.bin`)[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.value?.length).toBeGreaterThan(0);
    await setAccess(deployment, ADMIN_KEY, {
      project,
      roles: { lister: ["files.list"] },
      members: { ann: ["lister"] },
    });
    let got = first.value?.length ?? 0;
    const rest = (async () => {
      for (let r = await it.next(); !r.done; r = await it.next()) got += r.value.length;
    })();
    await expect(rest).rejects.toThrow(/EACCES/);
    expect(got).toBeLessThan(BIG);
    await setAccess(deployment, ADMIN_KEY, { project, members: { ann: ["editor"] } });
  });
});

async function writeBack(files: FilesClient, path: string) {
  await files.write(path, [enc.encode("keep again\n")]);
}

describe("workspace backends", () => {
  const backends: [string, Record<string, string>][] = [
    ["memory", { WORKSPACE_BACKEND: "memory" }],
    ["the local file system", { WORKSPACE_BACKEND: "local" }],
    ["S3", { WORKSPACE_BACKEND: "s3" }],
    ["SqlFs on the Durable Object's SQLite", { WORKSPACE_BACKEND: "sql" }],
  ].filter(
    // The local backend needs a local file system for the Worker (CellB Node and CellD only).
    ([, vars]) => CAN.localFiles || (vars as Record<string, string>).WORKSPACE_BACKEND !== "local",
  ) as [string, Record<string, string>][];
  it.each(backends)(
    "serves a workspace from %s, as the deployment's configuration says",
    async (_name, vars) => {
      const backend = await workspaceBackend(vars);
      const d = await startDeployment(HOST, {
        MODELS: model.deploymentModels(),
        DEV_LOGIN: "true",
        ADMIN_KEY,
        ...backend.vars,
      });
      try {
        await seed(d, ADMIN_KEY, {
          "/p/readme.md": "on this backend\n",
          "/p/.system/access": JSON.stringify({ ann: "owner" }),
        });
        const token = await login(d, "ann");
        const files = restFiles(d, token);
        expect(await readText(files, "/p/readme.md")).toBe("on this backend\n");
        await files.write("/p/big.bin", [new Uint8Array(3 * 1024 * 1024 + 7).fill(5)]);
        expect(await files.stats("/p/big.bin")).toMatchObject({ size: 3 * 1024 * 1024 + 7 });
        expect(await files.exists("/p/.system/access")).toBe(false);
        const client = restClient(d, token);
        const session = await client.startSession({ project: "p" });
        const turn = await client.sendMessage(session.id, {
          content: call("read", { path: "readme.md" }),
        });
        expect(toolResult(turn)).toMatchObject({ isError: false, output: "on this backend\n" });
        if (backend.holds) expect(await backend.holds("p/readme.md")).toBe(true);
      } finally {
        await d.close();
        await backend.close();
      }
    },
    120_000,
  );
});
