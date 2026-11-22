// The Pyodide code engine (statewalker/statewalker-root#142, decided in #94), for a runtime's host
// to install (`installCodeEngines({pyodide: pyodideEngine(...)})`) before it starts the deployment:
// CellB on Node (a child process under Node's permission model, `pyodideNodeHost`) and CellB in a
// browser (a module Worker, `pyodideWorkerHost`). The engine script is
// `@statewalker/ai-environment/engines/pyodide-engine.mjs`; Pyodide itself is the host's (its
// `indexURL`), not a dependency of this package.
//
// Pyodide's file system is synchronous, so the session's files are copied in: before each run,
// the files the session's view can read under its project (at most MAX_FILES files, MAX_BYTES
// bytes); after the run, each change is written back through the view, so the gate authorizes it
// again (a refused change is reported on stderr, and the run's exit code turns non-zero). The
// engine has no network: its realm has no `fetch` and its `js` module sees nothing.
import type {
  CodeEngine,
  EngineFiles,
  EngineInstance,
  EngineResult,
  EngineRun,
} from "./code-engines.js";

/** Where an engine process or Worker runs, and how messages reach it. */
export interface EngineHost {
  /** Pyodide's directory (Node) or URL (browser), with a trailing slash. */
  indexURL: string;
  start(
    onMessage: (m: unknown) => void,
    onExit: (why: string) => void,
    options: { memoryMb?: number },
  ): Promise<{ post(m: unknown): void; kill(): void }>;
}

/** What a run copies in by default: at most this many files and bytes of the project. */
const MAX_FILES = 5000;
const MAX_BYTES = 16 * 1024 * 1024;
/** Pyodide's own top folders: a project of that name cannot be copied in. */
const RESERVED = new Set([
  "/lib",
  "/usr",
  "/home",
  "/dev",
  "/proc",
  "/tmp",
  "/bin",
  "/etc",
  "/sys",
]);
/** How long Pyodide may take to load. */
const START_MS = 120_000;

type Content = string | { $b64: string };
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const toB64 = (b: Uint8Array) => {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
const bytesOf = (c: Content) =>
  typeof c === "string"
    ? new TextEncoder().encode(c)
    : Uint8Array.from(atob(c.$b64), (x) => x.charCodeAt(0));

async function readAll(files: EngineFiles, path: string): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let n = 0;
  for await (const chunk of files.read(path)) {
    parts.push(chunk);
    n += chunk.length;
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * The readable files under `root`, as contents (bounded), and the files left out (over the bounds,
 * or unreadable): those are never written back, since the run never saw what they hold.
 */
async function copyIn(files: EngineFiles, root: string, limits: { files: number; bytes: number }) {
  const out: Record<string, Content> = {};
  const skipped = new Set<string>();
  let count = 0;
  let bytes = 0;
  if (!(await files.exists(root))) return { files: out, skipped };
  for await (const e of files.list(root, { recursive: true })) {
    const entry = e as { kind?: string; path?: string; size?: number };
    if (entry.kind !== "file" || typeof entry.path !== "string") continue;
    if (count + 1 > limits.files || bytes + (entry.size ?? 0) > limits.bytes) {
      skipped.add(entry.path);
      continue;
    }
    try {
      const data = await readAll(files, entry.path);
      count++;
      bytes += data.length;
      try {
        out[entry.path] = utf8.decode(data);
      } catch {
        out[entry.path] = { $b64: toB64(data) };
      }
    } catch {
      skipped.add(entry.path);
    }
  }
  return { files: out, skipped };
}

type Changes = { written: Record<string, Content>; deleted: string[]; dirs: string[] };

/**
 * Writes a run's changes back through the view, each one authorized again. A file the run was
 * not given a copy of is never written over (it would lose what the run never saw), and a run
 * ended meanwhile (`signal`) stops at once: ECANCELED, with nothing more written.
 */
async function writeBack(
  files: EngineFiles,
  changes: Changes,
  copied: { files: Record<string, Content>; skipped: Set<string> },
  signal: AbortSignal,
): Promise<string[]> {
  const refused: string[] = [];
  const attempt = async (what: string, f: () => unknown) => {
    if (signal.aborted) throw new Error("ECANCELED: the run was ended during its write-back");
    try {
      await f();
    } catch (e) {
      refused.push(`${what}: ${String((e as Error)?.message ?? e)}`);
    }
  };
  for (const dir of [...(changes.dirs ?? [])].sort())
    await attempt(`mkdir ${dir}`, () => files.mkdir(dir));
  for (const [path, content] of Object.entries(changes.written ?? {}))
    await attempt(`write ${path}`, async () => {
      if (!(path in copied.files) && (copied.skipped.has(path) || (await files.exists(path))))
        throw new Error("EEXIST: the file was not copied in, so it is not written over");
      await files.write(path, [bytesOf(content)]);
    });
  for (const path of changes.deleted ?? [])
    await attempt(`remove ${path}`, () => files.remove(path));
  return refused;
}

/** The Pyodide engine over a host: one engine process or Worker per agent session. */
export function pyodideEngine(
  host: EngineHost,
  options: { maxFiles?: number; maxBytes?: number } = {},
): CodeEngine {
  const limits = { files: options.maxFiles ?? MAX_FILES, bytes: options.maxBytes ?? MAX_BYTES };
  return {
    programs: ["python", "python3"],
    async open({ files, memoryMb }): Promise<EngineInstance> {
      let ready: (v: unknown) => void = () => {};
      let failed: (e: Error) => void = () => {};
      const started = new Promise((resolve, reject) => {
        ready = resolve;
        failed = reject;
      });
      let dead: string | undefined;
      const answers = new Map<number, (m: Record<string, unknown>) => void>();
      const proc = await host.start(
        (raw) => {
          const m = raw as Record<string, unknown>;
          if (m?.type === "ready") ready(m.version);
          else if (m?.type === "failed")
            failed(new Error(`EIO: Pyodide failed to start: ${m.error}`));
          else if (m?.type === "result") answers.get(Number(m.id))?.(m);
        },
        (why) => {
          dead = why;
          failed(new Error(`EIO: the Python engine stopped: ${why}`));
          for (const answer of answers.values()) answer({ dead: why });
        },
        memoryMb ? { memoryMb } : {},
      );
      proc.post({ type: "init", indexURL: host.indexURL });
      const timer = setTimeout(
        () => failed(new Error("ETIMEDOUT: Pyodide did not start")),
        START_MS,
      );
      try {
        await started;
      } catch (e) {
        proc.kill();
        throw e;
      } finally {
        clearTimeout(timer);
      }
      let next = 0;
      let queue: Promise<unknown> = Promise.resolve();
      const runOne = async (run: EngineRun, signal: AbortSignal): Promise<EngineResult> => {
        if (dead) throw new Error(`EIO: the Python engine stopped: ${dead}`);
        const root = `/${run.cwd.split("/").filter(Boolean)[0] ?? ""}`;
        if (root === "/") throw new Error("EINVAL: python runs inside a project");
        if (RESERVED.has(root))
          throw new Error(
            `ENOSYS: a project named ${root.slice(1)} clashes with Pyodide's own folders`,
          );
        const synced = await copyIn(files, root, limits);
        const id = ++next;
        const answer = new Promise<Record<string, unknown>>((resolve) => answers.set(id, resolve));
        const onAbort = () => {
          // An aborted run's engine is killed: nothing it left reaches a later run.
          dead = "the run was ended";
          proc.kill();
          answers.get(id)?.({ dead: dead });
        };
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          proc.post({
            type: "run",
            id,
            root,
            files: synced.files,
            cwd: run.cwd,
            args: run.args,
            stdin: run.stdin ?? "",
          });
          const m = await answer;
          if (m.dead) throw new Error(`EIO: the Python engine stopped: ${m.dead}`);
          const refused = await writeBack(files, m.changes as Changes, synced, signal);
          let stderr = String(m.stderr ?? "");
          if (synced.skipped.size)
            stderr += `python: ${synced.skipped.size} file(s) not copied in (at most ${limits.files} files, ${limits.bytes} bytes)\n`;
          for (const r of refused) stderr += `python: not written back: ${r}\n`;
          const exitCode = Number(m.exitCode) || 0;
          return {
            stdout: String(m.stdout ?? "").slice(0, run.maxOutput),
            stderr: stderr.slice(0, run.maxOutput),
            exitCode: refused.length && !exitCode ? 1 : exitCode,
          };
        } finally {
          answers.delete(id);
          signal.removeEventListener("abort", onAbort);
        }
      };
      return {
        run(run, signal) {
          const result = queue.then(() => runOne(run, signal));
          queue = result.catch(() => {});
          return result;
        },
        close() {
          dead ??= "closed";
          proc.kill();
        },
      };
    },
  };
}

/** The engine script's URL, beside this module's package (`engines/pyodide-engine.mjs`). */
export function pyodideEngineUrl(): URL {
  // Not a literal: page bundlers would otherwise copy the script as an asset of their own.
  const relative = ["..", "engines", "pyodide-engine.mjs"].join("/");
  return new URL(relative, import.meta.url);
}

type ChildLike = {
  connected: boolean;
  send(m: unknown): boolean;
  kill(signal?: string): boolean;
  on(event: string, fn: (...a: unknown[]) => void): void;
  stderr?: { on(event: "data", fn: (d: { toString(): string }) => void): void } | null;
};

/**
 * Pyodide in a Node child process (CellB on Node): Node's permission model lets it read only
 * Pyodide's directory and the engine script; it cannot write files, start processes or workers;
 * code generation from strings is off; its environment is empty; its heap is capped.
 */
export function pyodideNodeHost(options: { indexDir: string; enginePath?: string }): EngineHost {
  const indexDir = options.indexDir.replace(/\/?$/, "/");
  const enginePath = options.enginePath ?? decodeURIComponent(pyodideEngineUrl().pathname);
  return {
    indexURL: indexDir,
    async start(onMessage, onExit, { memoryMb }) {
      // A non-literal specifier: bundlers for other runtimes leave this import alone.
      const name = "node:child_process";
      const { fork } = (await import(/* @vite-ignore */ name)) as {
        fork(path: string, args: string[], options: Record<string, unknown>): ChildLike;
      };
      const proc = (globalThis as { process?: { execPath?: string } }).process;
      const child = fork(enginePath, [], {
        execPath: proc?.execPath,
        execArgv: [
          "--permission",
          `--allow-fs-read=${indexDir}`,
          `--allow-fs-read=${enginePath}`,
          "--disallow-code-generation-from-strings",
          `--max-old-space-size=${memoryMb ?? 1024}`,
        ],
        env: {},
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        serialization: "json",
      });
      let stderr = "";
      child.stderr?.on("data", (d) => {
        stderr = (stderr + d.toString()).slice(-4000);
      });
      child.on("message", (m) => onMessage(m));
      child.on("exit", (code, signal) =>
        onExit(`exit ${code ?? signal}${stderr ? `: ${stderr.trim()}` : ""}`),
      );
      child.on("error", (e) => onExit(String((e as Error)?.message ?? e)));
      return {
        post: (m) => {
          if (child.connected) child.send(m);
        },
        kill: () => {
          child.kill("SIGKILL");
        },
      };
    },
  };
}

type WorkerLike = {
  postMessage(m: unknown): void;
  terminate(): void;
  addEventListener(type: string, fn: (e: { data?: unknown; message?: string }) => void): void;
};

/**
 * Pyodide in a module Worker (CellB in a browser). The page serves the engine script and Pyodide;
 * it should serve the script with a CSP (`default-src 'none'; script-src 'self'
 * 'wasm-unsafe-eval'; connect-src 'self'`), so the Worker has no eval and no other origin.
 */
export function pyodideWorkerHost(options: {
  engineUrl: string | URL;
  indexURL: string;
}): EngineHost {
  return {
    indexURL: options.indexURL.replace(/\/?$/, "/"),
    async start(onMessage, onExit) {
      const W = (
        globalThis as unknown as {
          Worker: new (url: string | URL, o: { type: "module"; name: string }) => WorkerLike;
        }
      ).Worker;
      const worker = new W(options.engineUrl, { type: "module", name: "python-engine" });
      worker.addEventListener("message", (e) => onMessage(e.data));
      worker.addEventListener("error", (e) => onExit(e.message || "worker error"));
      return {
        post: (m) => worker.postMessage(m),
        kill: () => worker.terminate(),
      };
    },
  };
}
