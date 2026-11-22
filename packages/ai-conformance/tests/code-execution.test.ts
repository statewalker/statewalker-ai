// Code execution (statewalker/statewalker-root#142, decided in #94): the agent's one `bash` tool
// routes `node`, `python` and WASIX programs to an executor the deployment offers. `node` scripts
// are bundled on the fly and run in a Worker Loader isolate of their own (held to the acceptance
// check, as workspace tool bundles are), with no network and files only through the session's
// capability; `python` and POSIX programs run on an engine where the runtime has one, and answer
// ENOSYS elsewhere. Running code is the `code.run` action: roles grant it (owner), modes decide it
// (`default` asks). An agent's `requires` is checked when its session starts. Each run's time is
// charged as `executor_cpu_ms:<kind>` to the workspace, project, member and session, and the run is
// killed when a limit refuses more. Against the harness's own deployment, with the scripted model,
// over REST and RPC.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CAN,
  type Deployment,
  exportUsage,
  type FakeModel,
  fakeModel,
  login,
  RUNTIME,
  restClient,
  rpcClient,
  type SessionClient,
  seed,
  startDeployment,
  type Turn,
} from "../src/index.js";

const HOST = new URL("../../ai-host-do/", import.meta.url);
const ADMIN_KEY = "conformance-admin-key";
const OPERATOR_KEY = "conformance-operator-key";
const AP = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

const CATALOG = {
  "/code/plugin.json": JSON.stringify({ $schema: AP, name: "code", version: "1.0.0" }),
  "/code/dev.cellb.harness/agents/default.md": "---\nname: default\n---\nDEFAULT\n",
  "/code/dev.cellb.harness/agents/js.md": "---\nname: js\nrequires: [node]\n---\nJS\n",
  "/code/dev.cellb.harness/agents/py.md": "---\nname: py\nrequires: [python, node]\n---\nPY\n",
  "/code/dev.cellb.harness/agents/odd.md": "---\nname: odd\nrequires: [cobol]\n---\nODD\n",
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

/** A file larger than the runner's Pyodide engine copies in (its `maxBytes`, 256 KiB). */
const BIG = "x".repeat(300 * 1024);

let model: FakeModel;
let deployment: Deployment;

const SCRIPTS = {
  "hello.mjs": `console.log("hello", process.argv.slice(2).join(" "));`,
  "files.mjs": `
    import { readFile, writeFile, readdir } from "node:fs/promises";
    import path from "node:path";
    const text = await readFile("doc.txt", "utf8");
    await writeFile(path.join("out", "count.txt"), String(text.split(/\\s+/).filter(Boolean).length));
    console.log((await readdir("out")).join(","));`,
  "peek.mjs": `
    import { readFile } from "node:fs/promises";
    try { console.log(await readFile(process.argv[2], "utf8")); }
    catch (e) { console.error("refused: " + e.message); process.exit(3); }`,
  "fail.mjs": `console.error("about to fail"); process.exitCode = 2;`,
  "net.mjs": `const r = await fetch("https://example.com/"); console.log(r.status);`,
  "spin.mjs": `for (;;) await new Promise((r) => setTimeout(r, 20));`,
  "unapproved.mjs": `console.log("not approved anywhere");`,
};

const vars = (extra: Record<string, string> = {}) => ({
  MODELS: model.deploymentModels(),
  DEV_LOGIN: "true",
  ADMIN_KEY,
  OPERATOR_KEY,
  CATALOG: JSON.stringify(CATALOG),
  DEFAULT_AGENT: "code/default",
  EXEC_TIMEOUT_MS: "6000",
  // WASIX programs the `bash` tool routes to the posix executor.
  EXECUTORS: JSON.stringify({ programs: ["rg", "tee"] }),
  ...extra,
});

/** The scripts the operator approves on CellB Node, by the hashes their refusals name. */
const APPROVED = ["hello.mjs", "files.mjs", "peek.mjs", "fail.mjs", "spin.mjs"];

/**
 * On CellB Node isolates run approved bundles only (#94): a `node` script's refusal names the
 * sha-256 of its bundle, which the operator approves (APPROVED_BUNDLES), as a run of this suite's
 * deployment does here for its scripts.
 */
async function approvedHashes(): Promise<string> {
  const probe = await startDeployment(HOST, vars());
  try {
    const files: Record<string, string> = {
      "/probe/.system/access": JSON.stringify({ "ann-probe": "owner" }),
    };
    for (const name of APPROVED) files[`/probe/${name}`] = SCRIPTS[name as keyof typeof SCRIPTS];
    await seed(probe, ADMIN_KEY, files);
    const ann = await restClient(probe, await login(probe, "ann-probe"));
    await ann.setMode({ mode: "bypassPermissions" });
    const s = await ann.startSession({ project: "probe" });
    const hashes: string[] = [];
    for (const name of APPROVED) {
      const out = outputOf(await ann.sendMessage(s.id, { content: bash(`node ${name}`) }));
      const hash = /sha256 ([0-9a-f]{64}), which is not approved/.exec(out)?.[1];
      if (!hash) throw new Error(`no refusal naming a hash for ${name}: ${out}`);
      hashes.push(hash);
    }
    return hashes.join(",");
  } finally {
    await probe.close();
  }
}

beforeAll(async () => {
  model = await fakeModel();
  deployment = await startDeployment(
    HOST,
    vars(RUNTIME === "node" ? { APPROVED_BUNDLES: await approvedHashes() } : {}),
  );
  const files: Record<string, string> = {};
  for (const t of ["rest", "rpc"]) {
    for (const p of [`code-${t}`, `meter-${t}`]) {
      files[`/${p}/.system/access`] = JSON.stringify({
        [`ann-${t}`]: "owner",
        [`bea-${t}`]: "owner",
        [`ed-${t}`]: "editor",
      });
      files[`/${p}/doc.txt`] = "one two three four";
      for (const [name, text] of Object.entries(SCRIPTS)) files[`/${p}/${name}`] = text;
      files[`/${p}/todo.txt`] = "one TODO\ntwo\nthree TODO\n";
      files[`/${p}/hello.py`] = "import sys\nprint('hello from python', *sys.argv[1:])\n";
      files[`/${p}/count.py`] = [
        "import os",
        "words = len(open('doc.txt').read().split())",
        "os.makedirs('pyout', exist_ok=True)",
        "open('pyout/count.txt', 'w').write(str(words))",
        "print('projects:', sorted(os.listdir('/')))",
        "try:",
        "    import urllib.request",
        "    urllib.request.urlopen('https://example.com/', timeout=5)",
        "    print('reached the network')",
        "except Exception as e:",
        "    print('no network:', type(e).__name__)",
      ].join("\n");
    }
    files[`/big-${t}/.system/access`] = JSON.stringify({ [`ann-${t}`]: "owner" });
    files[`/big-${t}/big.log`] = BIG;
    files[`/other-${t}/.system/access`] = JSON.stringify({ [`ann-${t}`]: "owner" });
    files[`/other-${t}/secret.txt`] = "not yours";
    files[`/meter-${t}/.system/limits`] = JSON.stringify([
      { meter: "executor_cpu_ms:isolate", level: "project", value: 600, period: "day" },
    ]);
  }
  await seed(deployment, ADMIN_KEY, files);
}, 120_000);
afterAll(async () => {
  for (const s of sockets) s.close();
  await deployment?.close();
  await model?.close();
});

const call = (tool: string, args: unknown) => `CALL ${tool} ${JSON.stringify(args)}`;
const bash = (command: string) => call("bash", { command });
const results = (turn: Turn) => turn.items.filter((i) => i.kind === "tool_result");
const outputOf = (turn: Turn) => String(results(turn).at(-1)?.output);

describe.each(transports)("code execution over %s", (name, connect) => {
  const t = name.toLowerCase();
  const project = `code-${t}`;
  const as = async (user: string, mode = "bypassPermissions") => {
    const client = await connect(deployment, await login(deployment, `${user}-${t}`));
    await client.setMode({ mode });
    return client;
  };

  it("runs a node script from bash in an isolate, with its arguments and output", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project });
    const turn = await ann.sendMessage(s.id, { content: bash("node hello.mjs big world") });
    expect(outputOf(turn)).toContain("hello big world");
  });

  it("runs a script only once its bundle is approved where isolates run approved bundles only (CellB Node)", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project });
    const turn = await ann.sendMessage(s.id, { content: bash("node unapproved.mjs") });
    if (RUNTIME === "node")
      expect(outputOf(turn)).toMatch(
        /node: ENOSYS: on this runtime \(CellB Node\) isolates run approved bundles only: .*unapproved\.mjs bundles to sha256 [0-9a-f]{64}/,
      );
    else expect(outputOf(turn)).toContain("not approved anywhere");
  });

  it("reaches the session's files through its capability, and only those", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project });
    await ann.sendMessage(s.id, {
      content: call("write", { path: `/${project}/out/keep.txt`, content: "k" }),
    });
    const turn = await ann.sendMessage(s.id, { content: bash("node files.mjs") });
    expect(outputOf(turn)).toContain("count.txt,keep.txt");
    const read = await ann.sendMessage(s.id, {
      content: call("read", { path: `/${project}/out/count.txt` }),
    });
    expect(outputOf(read)).toContain("4");
    const other = await ann.sendMessage(s.id, {
      content: bash(`node peek.mjs /other-${t}/secret.txt`),
    });
    expect(outputOf(other)).toContain("refused: ");
    expect(outputOf(other)).not.toContain("not yours");
    expect(outputOf(other)).toContain("exited with code 3");
  });

  it("answers a script's error output and exit code", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project });
    const turn = await ann.sendMessage(s.id, { content: bash("node fail.mjs") });
    expect(outputOf(turn)).toContain("about to fail");
    expect(outputOf(turn)).toContain("exited with code 2");
  });

  it("runs python on the runtime's engine, and answers ENOSYS where there is none", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project });
    const turn = await ann.sendMessage(s.id, { content: bash("python hello.py a b") });
    if (CAN.python) expect(outputOf(turn)).toContain("hello from python a b");
    else {
      expect(outputOf(turn)).toMatch(/python: ENOSYS/);
      expect(outputOf(turn)).toContain("exited with code 127");
    }
  });

  it("runs python on a copy of the project's files, writes changes back through the capability, with no network", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project });
    const turn = await ann.sendMessage(s.id, { content: bash("python count.py") });
    if (!CAN.python) {
      expect(outputOf(turn)).toMatch(/python: ENOSYS/);
      return;
    }
    expect(outputOf(turn)).toContain(`projects: ['${project}'`);
    expect(outputOf(turn)).not.toContain(`other-${t}`);
    expect(outputOf(turn)).toContain("no network:");
    const read = await ann.sendMessage(s.id, {
      content: call("read", { path: `/${project}/pyout/count.txt` }),
    });
    expect(outputOf(read)).toContain("4");
  });

  it("starts each python run from a fresh interpreter state: an edited module is imported anew", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project });
    const write = (path: string, content: string) =>
      ann.sendMessage(s.id, { content: call("write", { path: `/${project}/${path}`, content }) });
    await write("pyfresh/helper.py", "X = 1\n");
    await write(
      "pyfresh/main.py",
      "import os, helper\nprint('x', helper.X, os.environ.get('LEAK'))\nos.environ['LEAK'] = 'yes'\n",
    );
    const first = await ann.sendMessage(s.id, { content: bash("python pyfresh/main.py") });
    if (!CAN.python) {
      expect(outputOf(first)).toMatch(/python: ENOSYS/);
      return;
    }
    expect(outputOf(first)).toContain("x 1 None");
    await write("pyfresh/helper.py", "X = 2\n");
    const second = await ann.sendMessage(s.id, { content: bash("python pyfresh/main.py") });
    expect(outputOf(second)).toContain("x 2 None");
  });

  it("never writes back over a file python was not given a copy of", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project: `big-${t}` });
    const turn = await ann.sendMessage(s.id, {
      content: bash(`python -c "open('big.log', 'a').write('appended')"`),
    });
    if (!CAN.python) {
      expect(outputOf(turn)).toMatch(/python: ENOSYS/);
      return;
    }
    expect(outputOf(turn)).toMatch(/not written back: write \/big-\w+\/big\.log: .*not copied in/);
    const read = await ann.sendMessage(s.id, {
      content: call("bash", { command: "wc -c big.log" }),
    });
    expect(outputOf(read)).toContain(String(BIG.length));
  });

  it("authorizes python's write-back again: a change the mode asks about is not written", async () => {
    const bea = await as("bea", "default");
    const s = await bea.startSession({ project });
    const turn = await bea.sendMessage(s.id, {
      content: bash(`python -c "open('denied.txt', 'w').write('no')"`),
    });
    if (!CAN.python) {
      // Nothing to decide: there is no executor to run it on.
      expect(outputOf(turn)).toMatch(/python: ENOSYS/);
      return;
    }
    expect(turn.status).toBe("waiting");
    const id = String(turn.stop_reason?.approval_ids?.[0]);
    const { accepted } = await bea.answerApproval(id, { decision: "allow", scope: "once" });
    const done = await bea.waitTurn(accepted);
    expect(outputOf(done)).toMatch(/not written back: write \/code-\w+\/denied\.txt: EACCES/);
    const read = await bea.sendMessage(s.id, {
      content: call("read", { path: `/${project}/denied.txt` }),
    });
    expect(results(read).at(-1)).toMatchObject({ isError: true });
  });

  it("runs WASIX programs on a Wasmer engine, live over the session's files, and answers ENOSYS where there is none", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project });
    const turn = await ann.sendMessage(s.id, { content: bash("rg -c TODO todo.txt") });
    if (!CAN.posix) {
      expect(outputOf(turn)).toMatch(/rg: ENOSYS/);
      return;
    }
    expect(outputOf(turn)).toMatch(/^2\b/);
    const wrote = await ann.sendMessage(s.id, { content: bash("echo from wasmer | tee teed.txt") });
    expect(outputOf(wrote)).toContain("from wasmer");
    const read = await ann.sendMessage(s.id, {
      content: call("read", { path: `/${project}/teed.txt` }),
    });
    expect(outputOf(read)).toContain("from wasmer");
    const other = await ann.sendMessage(s.id, {
      content: bash(`rg -c yours /other-${t}/secret.txt`),
    });
    expect(outputOf(other)).not.toMatch(/^1\b/);
  });

  it("checks an agent's requires when its session starts", async () => {
    const ann = await as("ann");
    await expect(ann.startSession({ project, agent: "code/js" })).resolves.toMatchObject({
      id: expect.any(String),
    });
    if (CAN.python)
      await expect(ann.startSession({ project, agent: "code/py" })).resolves.toBeTruthy();
    else
      await expect(ann.startSession({ project, agent: "code/py" })).rejects.toThrow(
        /ENOSYS: the agent code\/py requires python, which this deployment cannot run/,
      );
    await expect(ann.startSession({ project, agent: "code/odd" })).rejects.toThrow(
      /requires 'cobol', which this harness does not know/,
    );
  });

  it("is the code.run action: the owner's, asked about in default mode, run once approved", async () => {
    const ed = await as("ed");
    const se = await ed.startSession({ project });
    const refused = await ed.sendMessage(se.id, { content: bash("node hello.mjs editor") });
    expect(outputOf(refused)).toMatch(/EACCES: may not run node code here \(code\.run:node\)/);
    const bea = await as("bea", "default");
    const s = await bea.startSession({ project });
    const turn = await bea.sendMessage(s.id, { content: bash("node hello.mjs once more") });
    expect(turn.status).toBe("waiting");
    const id = String(turn.stop_reason?.approval_ids?.[0]);
    const { accepted } = await bea.answerApproval(id, { decision: "allow", scope: "once" });
    const done = await bea.waitTurn(accepted);
    expect(outputOf(done)).toContain("hello once more");
    // The approval ran that run once: the next asks again.
    const again = await bea.sendMessage(s.id, { content: bash("node hello.mjs once more") });
    expect(again.status).toBe("waiting");
  });

  it("runs nothing more of the command line while a run waits on the user's approval", async () => {
    const bea = await as("bea", "acceptEdits");
    const s = await bea.startSession({ project });
    const after = `/${project}/after-${t}.txt`;
    const turn = await bea.sendMessage(s.id, {
      content: bash(
        `node hello.mjs x; echo after > ${after}; node hello.mjs y || echo failed > ${after}`,
      ),
    });
    expect(turn.status).toBe("waiting");
    const read = await bea.sendMessage(s.id, { content: call("read", { path: after }) });
    expect(results(read).at(-1)).toMatchObject({ isError: true });
  });

  it("charges a run's time as executor_cpu_ms:isolate, and kills it when a limit refuses more", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project: `meter-${t}` });
    const quick = await ann.sendMessage(s.id, { content: bash("node hello.mjs") });
    expect(outputOf(quick)).toContain("hello");
    const records = (await exportUsage(deployment, OPERATOR_KEY, { workspace: "default" })) as {
      project?: string;
      meter?: string;
      session?: string;
    }[];
    expect(
      records.filter((r) => r.project === `meter-${t}` && r.meter === "executor_cpu_ms:isolate"),
    ).not.toEqual([]);
    // The project allows 600 ms a day: a script that would go on is killed before its timeout.
    const spin = await ann.sendMessage(s.id, { content: bash("node spin.mjs") });
    expect(outputOf(spin)).toMatch(/node: ELIMIT/);
    const after = await ann.sendMessage(s.id, { content: bash("node hello.mjs") });
    expect(outputOf(after)).toMatch(/node: ELIMIT/);
  });

  it("kills a run at the session's own limit on executor time", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({
      project,
      limits: [{ meter: "executor_cpu_ms:isolate", value: 300, period: "total" }],
    });
    const spin = await ann.sendMessage(s.id, { content: bash("node spin.mjs") });
    expect(outputOf(spin)).toMatch(/node: ELIMIT/);
    expect(outputOf(spin)).not.toMatch(/ETIMEDOUT/);
  });

  it("ends a run at its timeout", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project });
    const spin = await ann.sendMessage(s.id, { content: bash("node spin.mjs") });
    expect(outputOf(spin)).toMatch(/node: ETIMEDOUT/);
  });

  it("refuses a script that reaches for the network: the isolate has none", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project });
    const turn = await ann.sendMessage(s.id, { content: bash("node net.mjs") });
    expect(outputOf(turn)).toMatch(/EACCES: .*names the global 'fetch'/);
  });
});
