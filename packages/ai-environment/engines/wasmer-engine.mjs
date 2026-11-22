// The Wasmer engine (statewalker/statewalker-root#142, decided in #94): runs WASIX programs (bash,
// coreutils, ripgrep, ...) in Wasmer sandboxes whose /workspace is the agent session's file view.
// A Node child process (src/wasmer.ts, wasmerNodeHost): control messages over IPC; the sandbox's
// file operations over two pipes (fd 4: requests, fd 5: replies), answered by the host through the
// session's view. One sandbox per run.
//
// Messages (host → engine):
//   {type: "init", packages, sdk, cache?}                 the allowed packages, loaded here once
//   {type: "open", run, env?}                             → {type: "opened", run} | {type: "error", run, error}
//   {type: "exec", run, req, script, cwd?, env?, timeoutMs?, outputBytes?}
//                                                         → {type: "result", run, req, exitCode, reason, stdout, stderr, truncated}
//   {type: "close", run}
// Engine → host: {type: "ready"} | {type: "failed", error}.
//
// Network: sandboxes have none (`network: {mode: "disabled"}`). The guest's built-in `wasmer`
// command would resolve registry packages with the host's fetch, in the SDK's worker threads: the
// allowed packages are loaded at init, and from then on fetch refuses everything (in the workers
// from their start, wasmer-preload.mjs; in this thread once the packages are in).
//
// The SDK's `storageHost(mount)` (an embedder file system as /workspace) is experimental and not in
// its public options: each sandbox is built through the core builder, with the run id as the mount.
// In a browser (src/wasmer.ts, wasmerWorkerHost) it is a module Worker: the sandbox's file
// operations are the SDK's own blocking bridge messages, forwarded to the host and answered in
// place (shared memory), so the page must be cross-origin isolated.
// Ported from statewalker-sandbox apps/flue-capfs-do/src/wasmer/engine.mjs.
const IN_NODE =
  typeof process !== "undefined" &&
  !!process.versions?.node &&
  typeof window === "undefined" &&
  typeof WorkerGlobalScope === "undefined";
const send = IN_NODE ? (m) => process.send?.(m) : (m) => self.postMessage(m);
if (IN_NODE) process.on("disconnect", () => process.exit(0));

let sdk;
let core;
let wasmer;
let nextMount = 0;
const sandboxes = new Map();
const packages = new Map();
const closedEarly = new Set();
let opening = Promise.resolve();
let allowed = [];

const noNetwork = () =>
  Promise.reject(new TypeError("fetch: the Wasmer engine has no network after start"));

const BROWSER_WORKER = /\/browser-worker\.js(\?|$)/;
/** Browser: what an SDK worker runs instead of browser-worker.js (the same, without fetch). */
const sealedWorker = (url) =>
  URL.createObjectURL(
    new Blob(
      [
        `import ${JSON.stringify(url)};
const refuse = () => Promise.reject(new TypeError("fetch: the Wasmer engine has no network"));
globalThis.fetch = refuse;
const W = globalThis.Worker;
if (W) globalThis.Worker = class extends W {
  constructor(u, o) { super(${BROWSER_WORKER}.test(String(u)) ? import.meta.url : u, o); }
};
`,
      ],
      { type: "text/javascript" },
    ),
  );

async function initBrowser(m) {
  const base = new URL(m.sdk, self.location.href);
  sdk = await import(base.href);
  core = await import(new URL("../pkg/wasmer_sdk_js.js", base).href);
  const bridge = await import(new URL("./host-filesystem.js", base).href);
  // This worker's own calls block here, answered in place by the host (its parent).
  bridge.installHostFileSystemWorkerBridge();
  // Calls from the SDK's workers arrive here as messages: forward them to the host.
  const NativeWorker = self.Worker;
  let sealed;
  self.Worker = class extends NativeWorker {
    constructor(url, opts) {
      let u = url;
      // SDK workers run without fetch (see above).
      if (BROWSER_WORKER.test(String(u)) && opts?.type === "module") {
        sealed ??= sealedWorker(String(u));
        u = sealed;
      }
      super(u, opts);
      this.addEventListener("message", (e) => {
        if (bridge.isHostFileSystemRequest(e.data)) {
          e.stopImmediatePropagation();
          self.postMessage(e.data);
        }
      });
    }
  };
  wasmer = new sdk.Wasmer();
}

async function initNode(m) {
  const { join } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const { Worker } = await import("node:worker_threads");
  const dist = m.sdk;
  sdk = await import(pathToFileURL(join(dist, "node.js")).href);
  core = await import(pathToFileURL(join(dist, "../pkg/wasmer_sdk_js.js")).href);
  const bridge = await import(pathToFileURL(join(dist, "host-filesystem.js")).href);
  // File requests are answered by a thread of their own that talks to the host over pipes: this
  // thread may itself be the one waiting on a reply.
  const fsThread = new Worker(new URL("./wasmer-fs-thread.mjs", import.meta.url), {
    workerData: { bridge: pathToFileURL(join(dist, "host-filesystem.js")).href },
  });
  fsThread.unref();
  bridge.installHostFileSystemWorkerBridge((req) => {
    fsThread.postMessage(req);
    return true;
  });
  // Requests from the SDK's worker threads (forwarded by wasmer-preload.mjs) go there too.
  const emit = Worker.prototype.emit;
  Worker.prototype.emit = function (event, data, ...rest) {
    if (this !== fsThread && event === "message" && bridge.isHostFileSystemRequest(data)) {
      fsThread.postMessage(data);
      return true;
    }
    return emit.call(this, event, data, ...rest);
  };
  wasmer = new sdk.Wasmer({ cache: m.cache ? { directory: m.cache } : false });
}

async function init(m) {
  if (IN_NODE) await initNode(m);
  else await initBrowser(m);
  // Every sandbox built from here gets the host's file system (mount nextMount) as /workspace.
  const start = core.SandboxBuilderCore.prototype.start;
  core.SandboxBuilderCore.prototype.start = function () {
    this.storageHost(nextMount);
    return start.call(this);
  };
  await wasmer.ready();
  allowed = [...new Set(m.packages ?? [])];
  const loaded = await wasmer.packages.loadMany(allowed);
  for (const [i, name] of allowed.entries()) packages.set(name, loaded[i]);
  globalThis.fetch = noNetwork;
}

function open(m) {
  const build = opening.then(async () => {
    nextMount = m.run;
    const sandbox = await wasmer.sandboxes.create({
      packages: allowed.map((name) => packages.get(name)),
      shell: allowed.includes("wasmer/bash") ? "bash" : undefined,
      env: m.env ?? {},
      network: { mode: "disabled" },
    });
    if (closedEarly.delete(m.run)) {
      await sandbox.close();
      throw Object.assign(new Error("closed before it opened"), { code: "ECANCELED" });
    }
    sandboxes.set(m.run, sandbox);
  });
  opening = build.catch(() => {});
  return build;
}

async function exec(m) {
  const sandbox = sandboxes.get(m.run);
  if (!sandbox) throw Object.assign(new Error("no sandbox for this run"), { code: "EBADF" });
  const out = await sandbox
    .shell(m.script, { cwd: m.cwd ?? "/workspace", env: m.env })
    .run({ check: false, timeoutMs: m.timeoutMs, outputBytes: m.outputBytes });
  return {
    exitCode: out.exitCode,
    reason: out.reason,
    stdout: new TextDecoder().decode(out.stdout.bytes),
    stderr: new TextDecoder().decode(out.stderr.bytes),
    truncated: out.stdout.truncated || out.stderr.truncated,
  };
}

async function handle(m) {
  try {
    if (m.type === "init") {
      await init(m);
      send({ type: "ready" });
    } else if (m.type === "open") {
      await open(m);
      send({ type: "opened", run: m.run });
    } else if (m.type === "exec") {
      send({ type: "result", run: m.run, req: m.req, ...(await exec(m)) });
    } else if (m.type === "close") {
      const s = sandboxes.get(m.run);
      if (!s) closedEarly.add(m.run);
      sandboxes.delete(m.run);
      await s?.close();
    }
  } catch (e) {
    const error = `${e?.code ? `${e.code}: ` : ""}${e?.message ?? e}`;
    if (m.type === "init") send({ type: "failed", error });
    else send({ type: "error", run: m.run, req: m.req, error });
  }
}

if (IN_NODE) process.on("message", (m) => void handle(m));
else self.onmessage = ({ data }) => void handle(data);
