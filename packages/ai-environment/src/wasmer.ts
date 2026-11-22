// The Wasmer code engine (statewalker/statewalker-root#142, decided in #94), for a runtime's host to
// install (`installCodeEngines({wasmer: wasmerEngine(...)})`) before it starts the deployment:
// WASIX programs (bash, coreutils, ripgrep, ...) from the Wasmer registry, limited to the host's
// `packages`, run in a Wasmer sandbox whose /workspace is the agent session's file view, every file
// operation forwarded live and decided by the gate (./wasmer-fs.ts). No network.
//
// CellB on Node: one child process per agent session (`engines/wasmer-engine.mjs`) under Node's
// permission model (it reads files, writes only the package cache, starts worker threads, starts no
// process), the SDK (`@wasmer/sdk`, the host's, not a dependency of this package) loaded from
// `sdkDist`. Each run is a sandbox of its own, closed when the run ends.
import type { CodeEngine, EngineFiles, EngineInstance, EngineRun } from "./code-engines.js";
import { decodeWire, encodeWire, type HostFsReply, viewHostFs } from "./wasmer-fs.js";

export const DEFAULT_WASMER_PACKAGES = [
  "wasmer/bash",
  "wasmer/coreutils",
  "wasmer/grep",
  "wasmer/ripgrep",
  "wasmer/findutils",
];

/** Where the guest sees the session's file view. */
const MOUNT = "/workspace";
const START_MS = 180_000;
/** A file operation the view has not answered by then fails (the guest is blocked on it). */
const FS_DEADLINE_MS = 20_000;

/** A word as bash reads it, quoted. */
const quote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** The view's path as the guest sees it. */
const guestPath = (p: string) => `${MOUNT}${p === "/" ? "" : p}`;

/** The command line of a run, its paths in the session's project mapped into /workspace. */
function scriptOf(run: EngineRun): string {
  const project = run.cwd.split("/").filter(Boolean)[0];
  const mapped = run.args.map((a) =>
    project && (a === `/${project}` || a.startsWith(`/${project}/`)) ? guestPath(a) : a,
  );
  const line = [run.command, ...mapped].map(quote).join(" ");
  if (!run.stdin) return line;
  let fence = "HARNESS_STDIN";
  while (run.stdin.includes(fence)) fence += "_";
  return `${line} <<'${fence}'\n${run.stdin.replace(/\n$/, "")}\n${fence}`;
}

type ChildLike = {
  connected: boolean;
  send(m: unknown): boolean;
  kill(signal?: string): boolean;
  on(event: string, fn: (...a: unknown[]) => void): void;
  stdio: unknown[];
  stderr?: { on(event: "data", fn: (d: { toString(): string }) => void): void } | null;
};
type Readable = {
  setEncoding(e: string): void;
  on(event: string, fn: (d: unknown) => void): void;
};
type Writable = { write(s: string): boolean; on(event: string, fn: (e: Error) => void): void };

/** What the engine inherits: the proxy settings it needs to fetch packages, nothing else. */
function engineEnv(sdkDist: string): Record<string, string> {
  const from = (globalThis as { process?: { env?: Record<string, string> } }).process?.env ?? {};
  const out: Record<string, string> = { WASMER_SDK_DIST: sdkDist };
  for (const k of [
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "https_proxy",
    "http_proxy",
    "no_proxy",
    "NODE_EXTRA_CA_CERTS",
  ])
    if (from[k]) out[k] = from[k];
  if (out.HTTPS_PROXY || out.https_proxy || out.HTTP_PROXY || out.http_proxy)
    out.NODE_USE_ENV_PROXY = "1";
  return out;
}

const engineFile = (name: string) => {
  // Not a literal: page bundlers would otherwise copy the script as an asset of their own.
  const relative = ["..", "engines", name].join("/");
  return decodeURIComponent(new URL(relative, import.meta.url).pathname);
};

/**
 * The Wasmer engine on Node (CellB on Node): `sdkDist` is the `dist` folder of `@wasmer/sdk`
 * (0.19), `packages` the registry packages a run may use (bash is always there), `cache` a folder
 * the engine may write its package cache in.
 */
export function wasmerEngine(options: {
  sdkDist: string;
  packages?: string[];
  cache?: string;
}): CodeEngine {
  const packages = [...new Set(["wasmer/bash", ...(options.packages ?? DEFAULT_WASMER_PACKAGES)])];
  const sdkDist = options.sdkDist.replace(/\/$/, "");
  return {
    programs: ["bash", "sh"],
    async open({ files, memoryMb }) {
      return openNode(files, { sdkDist, packages, cache: options.cache, memoryMb });
    },
  };
}

async function openNode(
  files: EngineFiles,
  o: { sdkDist: string; packages: string[]; cache?: string; memoryMb?: number },
): Promise<EngineInstance> {
  const name = "node:child_process";
  const { fork } = (await import(/* @vite-ignore */ name)) as {
    fork(path: string, args: string[], options: Record<string, unknown>): ChildLike;
  };
  const proc = (globalThis as { process?: { execPath?: string } }).process;
  const child = fork(engineFile("wasmer-engine.mjs"), [], {
    execPath: proc?.execPath,
    execArgv: [
      "--permission",
      "--allow-fs-read=*",
      ...(o.cache ? [`--allow-fs-write=${o.cache}`] : []),
      "--allow-worker",
      "--import",
      engineFile("wasmer-preload.mjs"),
      `--max-old-space-size=${o.memoryMb ?? 2048}`,
      "--no-warnings",
    ],
    env: engineEnv(o.sdkDist),
    // 0 1 2 3 = stdin, stdout, stderr, IPC; 4 = file requests (engine → here), 5 = replies.
    stdio: ["ignore", "ignore", "pipe", "ipc", "pipe", "pipe"],
    serialization: "json",
  });
  let dead: string | undefined;
  let stderr = "";
  const waiting = new Map<string, (m: Record<string, unknown>) => void>();
  const die = (why: string) => {
    dead ??= why;
    for (const w of waiting.values())
      w({ type: "error", error: `EIO: the Wasmer engine stopped: ${why}` });
    waiting.clear();
  };
  child.stderr?.on("data", (d) => {
    stderr = (stderr + d.toString()).slice(-4000);
  });
  child.on("exit", (code, signal) =>
    die(`exit ${code ?? signal}${stderr ? `: ${stderr.trim()}` : ""}`),
  );
  child.on("error", (e) => die(String((e as Error)?.message ?? e)));
  const wait = (key: string) =>
    new Promise<Record<string, unknown>>((resolve) => {
      if (dead) resolve({ type: "error", error: `EIO: the Wasmer engine stopped: ${dead}` });
      else waiting.set(key, resolve);
    });
  child.on("message", (raw) => {
    const m = raw as Record<string, unknown>;
    const key =
      m.type === "ready" || m.type === "failed"
        ? "init"
        : m.type === "opened" || m.req === undefined
          ? `open:${m.run}`
          : `exec:${m.run}:${m.req}`;
    const w = waiting.get(key);
    if (!w) return;
    waiting.delete(key);
    w(m);
  });
  // The file channel: one request at a time, answered with the current run's mount.
  let mount: ReturnType<typeof viewHostFs> | undefined;
  let mountId = 0;
  const requests = child.stdio[4] as Readable;
  const replies = child.stdio[5] as Writable;
  const broken = (e: Error) => {
    child.kill("SIGKILL");
    die(`file channel: ${e.message}`);
  };
  (requests as unknown as Writable).on("error", broken);
  replies.on("error", broken);
  requests.setEncoding("utf8");
  let buffered = "";
  let chain: Promise<unknown> = Promise.resolve();
  const answer = async (line: string): Promise<string> => {
    let r: HostFsReply;
    try {
      const req = JSON.parse(line) as { mount: number; method: string; args: unknown[] };
      const h = req.mount === mountId ? mount : undefined;
      if (!h) r = { error: { code: "EACCES", message: "EACCES: the run is over" } };
      else {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const late = new Promise<HostFsReply>((resolve) => {
          timer = setTimeout(
            () =>
              resolve({
                error: {
                  code: "ETIMEDOUT",
                  message: `${req.method}: no answer in ${FS_DEADLINE_MS} ms`,
                },
              }),
            FS_DEADLINE_MS,
          );
        });
        r = await Promise.race([
          h.handle(req.method, decodeWire(req.args) as unknown[]),
          late,
        ]).finally(() => clearTimeout(timer));
      }
    } catch (e) {
      r = { error: { code: "EIO", message: String((e as Error)?.message ?? e) } };
    }
    return JSON.stringify("value" in r ? { value: encodeWire(r.value) } : r);
  };
  requests.on("data", (d) => {
    buffered += String(d);
    let nl = buffered.indexOf("\n");
    while (nl >= 0) {
      const line = buffered.slice(0, nl);
      buffered = buffered.slice(nl + 1);
      chain = chain.then(async () => replies.write(`${await answer(line)}\n`));
      nl = buffered.indexOf("\n");
    }
  });
  const post = (m: unknown) => {
    if (child.connected) child.send(m);
  };
  const ready = wait("init");
  post({
    type: "init",
    packages: o.packages,
    sdk: o.sdkDist,
    ...(o.cache ? { cache: o.cache } : {}),
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const started = await Promise.race([
    ready,
    new Promise<Record<string, unknown>>((resolve) => {
      timer = setTimeout(
        () => resolve({ type: "failed", error: "it did not start in time" }),
        START_MS,
      );
    }),
  ]).finally(() => clearTimeout(timer));
  if (started.type !== "ready") {
    child.kill("SIGKILL");
    throw new Error(`EIO: the Wasmer engine failed to start: ${started.error}`);
  }

  let queue: Promise<unknown> = Promise.resolve();
  let req = 0;
  const runOne = async (run: EngineRun, signal: AbortSignal) => {
    if (dead) throw new Error(`EIO: the Wasmer engine stopped: ${dead}`);
    const id = ++mountId;
    mount = viewHostFs(files);
    const onAbort = () => {
      // An aborted run's engine is killed: nothing it left reaches a later run.
      child.kill("SIGKILL");
      die("the run was ended");
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const opened = wait(`open:${id}`);
      post({ type: "open", run: id, env: run.env ?? {} });
      const o1 = await opened;
      if (o1.type === "error") throw new Error(String(o1.error));
      const n = ++req;
      const done = wait(`exec:${id}:${n}`);
      post({
        type: "exec",
        run: id,
        req: n,
        script: scriptOf(run),
        cwd: guestPath(run.cwd),
        env: run.env,
        outputBytes: run.maxOutput,
      });
      const r = await done;
      if (r.type === "error") throw new Error(String(r.error));
      return {
        stdout: String(r.stdout ?? ""),
        stderr: String(r.stderr ?? ""),
        exitCode: Number(r.exitCode) || 0,
      };
    } finally {
      signal.removeEventListener("abort", onAbort);
      mount?.close();
      mount = undefined;
      post({ type: "close", run: id });
    }
  };
  return {
    run(run, signal) {
      const result = queue.then(() => runOne(run, signal));
      queue = result.catch(() => {});
      return result;
    },
    close() {
      die("closed");
      child.kill("SIGKILL");
    },
  };
}
