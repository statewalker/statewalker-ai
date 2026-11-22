// `node` scripts from the agent's `bash` tool (statewalker/statewalker-root#142, decided in #94):
// bundled on the fly by webrun-bundler from the session's file view (reads through the gate, bare
// imports from the project's own `node_modules`, nothing fetched), held to the acceptance check
// (self-contained, no global outside the language's own, the Worker's harmless ones and the
// `process` its isolate defines), and run in a Worker Loader isolate of their own, through the
// same runner as tool bundles (./tool-executor.ts): no network, no `env`, the realm hardened before
// the script is evaluated, files only through the run's host while the run lasts.
//
// What a script sees of Node: `process` (argv, env, cwd(), exit(), exitCode, stdout/stderr.write),
// `console` (stdout and stderr, each cut at the output cap), `node:fs/promises` (and the promises of
// `node:fs`; its synchronous calls answer ENOSYS: an isolate has no synchronous file system),
// `node:path` (POSIX). Relative paths resolve from the shell's working directory; absolute ones are
// paths of the session's file view (`/<project>/...`). The run ends when the script's module has
// been evaluated (top-level `await` included) or it calls `process.exit`.

import { codedError } from "@statewalker/ai-access";
import { acceptBundle } from "@statewalker/ai-definitions";
import { bundle, type Esbuild, nodeModulesPackages } from "@statewalker/webrun-bundler";
import type { FilesApi } from "@statewalker/webrun-files";
import type { WorkerLoaderLike } from "./env.js";
import {
  GATEWAY_FETCH,
  PLUMBING,
  runBundle,
  ToolHost,
  type ToolHostCalls,
} from "./tool-executor.js";

/** The globals a `node` script may name beside the language's: what its isolate defines. */
const NODE_GLOBALS = ["process", "__harness"];

const PATH_SHIM = `
const norm = (p) => {
  const abs = p.startsWith("/");
  const out = [];
  for (const s of p.split("/")) {
    if (!s || s === ".") continue;
    if (s === "..") { if (out.length && out[out.length - 1] !== "..") out.pop(); else if (!abs) out.push(".."); }
    else out.push(s);
  }
  const r = (abs ? "/" : "") + out.join("/");
  return r || (abs ? "/" : ".");
};
export const sep = "/";
export const delimiter = ":";
export const normalize = (p) => { const n = norm(String(p)); return String(p).endsWith("/") && n !== "/" ? n + "/" : n; };
export const join = (...parts) => norm(parts.filter((x) => x !== "").join("/") || ".");
export const isAbsolute = (p) => String(p).startsWith("/");
export const resolve = (...parts) => {
  let r = "";
  for (let i = parts.length - 1; i >= 0 && !r.startsWith("/"); i--) r = parts[i] + (r ? "/" + r : "");
  if (!r.startsWith("/")) r = __harness.cwd + "/" + r;
  return norm(r);
};
export const dirname = (p) => { const n = norm(String(p)); const i = n.lastIndexOf("/"); return i < 0 ? "." : i === 0 ? "/" : n.slice(0, i); };
export const basename = (p, ext) => { const b = norm(String(p)).split("/").pop() ?? ""; return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b; };
export const extname = (p) => { const b = basename(p); const i = b.lastIndexOf("."); return i <= 0 ? "" : b.slice(i); };
export const relative = (from, to) => {
  const a = resolve(from).split("/").filter(Boolean), b = resolve(to).split("/").filter(Boolean);
  let i = 0; while (i < a.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
};
export const parse = (p) => { const base = basename(p); const ext = extname(p); return { root: isAbsolute(p) ? "/" : "", dir: dirname(p), base, ext, name: ext ? base.slice(0, -ext.length) : base }; };
export const format = (o) => (o.dir ? o.dir + "/" : "") + (o.base ?? (o.name ?? "") + (o.ext ?? ""));
const path = { sep, delimiter, normalize, join, isAbsolute, resolve, dirname, basename, extname, relative, parse, format };
path.posix = path;
export const posix = path;
export default path;
`;

const FS_PROMISES_SHIM = `
import { resolve } from "node:path";
const host = () => __harness.host;
const err = (e, p) => {
  const message = String(e?.message ?? e);
  const code = /^([A-Z][A-Z0-9_]+):/.exec(message)?.[1];
  const out = new Error(message);
  if (code) out.code = code;
  out.path = p;
  return out;
};
const call = async (p, f) => { try { return await f(resolve(String(p))); } catch (e) { throw err(e, p); } };
const encoding = (o) => (typeof o === "string" ? o : o?.encoding);
const bytesOf = (data, o) => typeof data === "string" ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data.buffer ?? data);
const statOf = (s) => {
  if (!s) return s;
  const file = s.kind === "file";
  const mtime = new Date(file ? s.lastModified ?? 0 : 0);
  return { size: file ? s.size ?? 0 : 0, mtime, mtimeMs: mtime.getTime(), isFile: () => file, isDirectory: () => !file, isSymbolicLink: () => false };
};
export const readFile = (p, o) => call(p, async (a) => {
  const data = new Uint8Array(await host().read(a));
  const enc = encoding(o);
  return enc ? new TextDecoder().decode(data) : data;
});
export const writeFile = (p, data, o) => call(p, (a) => host().write(a, bytesOf(data, o)));
export const appendFile = (p, data, o) => call(p, async (a) => {
  const before = (await host().exists(a)) ? new Uint8Array(await host().read(a)) : new Uint8Array();
  const added = bytesOf(data, o);
  const all = new Uint8Array(before.length + added.length);
  all.set(before); all.set(added, before.length);
  await host().write(a, all);
});
export const stat = (p) => call(p, async (a) => {
  const s = await host().stats(a);
  if (!s) throw new Error("ENOENT: no such file or directory, '" + p + "'");
  return statOf(s);
});
export const lstat = stat;
export const access = (p) => call(p, async (a) => { if (!(await host().exists(a))) throw new Error("ENOENT: no such file or directory, '" + p + "'"); });
export const readdir = (p, o) => call(p, async (a) => {
  const entries = await host().list(a, !!o?.recursive);
  return o?.withFileTypes
    ? entries.map((e) => ({ name: e.name, isFile: () => e.kind === "file", isDirectory: () => e.kind === "directory", isSymbolicLink: () => false }))
    : entries.map((e) => o?.recursive ? String(e.path ?? e.name).replace(a.endsWith("/") ? a : a + "/", "") : e.name);
});
export const mkdir = (p, o) => call(p, async (a) => { await host().mkdir(a); return o?.recursive ? a : undefined; });
export const rm = (p, o) => call(p, async (a) => {
  if (!(await host().exists(a))) { if (o?.force) return; throw new Error("ENOENT: no such file or directory, '" + p + "'"); }
  const s = await host().stats(a);
  if (s?.kind === "directory" && !o?.recursive) throw new Error("EISDIR: is a directory, '" + p + "'");
  await host().remove(a);
});
export const unlink = (p) => rm(p);
export const rmdir = (p, o) => rm(p, { recursive: !!o?.recursive });
export const rename = (from, to) => call(from, async (a) => { if (!(await host().move(a, resolve(String(to))))) throw new Error("ENOENT: no such file or directory, '" + from + "'"); });
export const copyFile = (from, to) => call(from, async (a) => { if (!(await host().copy(a, resolve(String(to))))) throw new Error("ENOENT: no such file or directory, '" + from + "'"); });
export const cp = (from, to) => copyFile(from, to);
export default { readFile, writeFile, appendFile, stat, lstat, access, readdir, mkdir, rm, unlink, rmdir, rename, copyFile, cp };
`;

const FS_SHIM = `
import * as promises from "node:fs/promises";
const sync = (name) => () => { const e = new Error("ENOSYS: fs." + name + " is synchronous, and a node script in an isolate has no synchronous file system: use node:fs/promises"); e.code = "ENOSYS"; throw e; };
export { promises };
export const readFileSync = sync("readFileSync");
export const writeFileSync = sync("writeFileSync");
export const existsSync = sync("existsSync");
export const readdirSync = sync("readdirSync");
export const statSync = sync("statSync");
export const mkdirSync = sync("mkdirSync");
export default { promises, readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync };
`;

const PROCESS_SHIM = `
const p = process;
export default p;
export const argv = p.argv, env = p.env, cwd = p.cwd, exit = p.exit, stdout = p.stdout, stderr = p.stderr, platform = p.platform, nextTick = p.nextTick;
`;

/** The Node modules a script may import, by every name it may use. */
const NODE_MODULES: Record<string, string> = {};
for (const [names, source] of [
  [["node:path", "path", "node:path/posix", "path/posix"], PATH_SHIM],
  [["node:fs/promises", "fs/promises"], FS_PROMISES_SHIM],
  [["node:fs", "fs"], FS_SHIM],
  [["node:process", "process"], PROCESS_SHIM],
] as const)
  for (const name of names) NODE_MODULES[name] = source;

/** The isolate's main module for a `node` script: Node's globals over the run's host. */
const NODE_MAIN = `
import { WorkerEntrypoint } from "cloudflare:workers";
import "./harden.js";
import main from "./tool.js";

const controller = new AbortController();
${PLUMBING}
${GATEWAY_FETCH}
class Exit { constructor(code) { this.code = code; } }
const define = (name, value) => {
  try { Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }); } catch {}
};

export default class extends WorkerEntrypoint {
  ready() { return true; }
  abort(reason) {
    controller.abort(new Error(String(reason)));
    // An ended script waits forever on its next timer: it stops, and reaches nothing more.
    define("setTimeout", () => 0);
    define("setInterval", () => 0);
  }
  run(input, stub) { return this.#run(input, stub); }
  start(input) {
    void this.#run(input, host).then((r) => { outcome = r; notify(); });
    return next();
  }
  resume(answers) {
    for (const a of Array.isArray(answers) ? answers : []) {
      const w = waiting.get(a?.id);
      if (!w) continue;
      waiting.delete(a.id);
      if (a.ok) w.resolve(a.value);
      else w.reject(new Error(String(a.error)));
    }
    return next();
  }
  async #run(input, host) {
    const max = Number(input.maxOutput) || 1048576;
    const streams = { stdout: "", stderr: "" };
    const put = (name) => (text) => {
      if (streams[name].length > max) return true;
      streams[name] += String(text);
      return true;
    };
    const show = (v) => { if (typeof v === "string") return v; try { return v instanceof Error ? String(v.stack ?? v) : JSON.stringify(v) ?? String(v); } catch { return String(v); } };
    const line = (name) => (...args) => { put(name)(args.map(show).join(" ") + "\\n"); };
    const console = { log: line("stdout"), info: line("stdout"), debug: line("stdout"), warn: line("stderr"), error: line("stderr"), trace: line("stderr") };
    define("console", console);
    const proc = {
      argv: ["node", String(input.script), ...(input.args ?? []).map(String)],
      env: { ...(input.env ?? {}) },
      exitCode: undefined,
      platform: "linux",
      version: "v24.0.0",
      versions: { node: "24.0.0" },
      cwd: () => String(input.cwd),
      exit(code) { throw new Exit(code ?? proc.exitCode ?? 0); },
      stdout: { write: put("stdout"), isTTY: false },
      stderr: { write: put("stderr"), isTTY: false },
      stdin: { isTTY: false },
      nextTick: (f, ...a) => queueMicrotask(() => f(...a)),
      on() { return proc; },
      once() { return proc; },
      hrtime: { bigint: () => BigInt(Math.round(performance.now() * 1e6)) },
      signal: controller.signal,
    };
    define("process", proc);
    define("__harness", { host, console, fetch: gatewayFetchOf(host), cwd: String(input.cwd), stdin: String(input.stdin ?? "") });
    let exitCode = 0;
    try {
      await main();
      exitCode = Number(proc.exitCode ?? 0) || 0;
    } catch (e) {
      if (e instanceof Exit) exitCode = Number(e.code) || 0;
      else { put("stderr")(show(e) + "\\n"); exitCode = 1; }
    }
    const cut = (s) => s.length > max ? s.slice(0, max) + "\\n[output cut at " + max + " characters]\\n" : s;
    return { ok: true, output: JSON.stringify({ stdout: cut(streams.stdout), stderr: cut(streams.stderr), exitCode }), logs: [] };
  }
}
`;

/**
 * Bundles a `node` script of the session's file view: its imports resolved through the view, the
 * Node modules a script may use supplied by the isolate's shims, the bundle held to the acceptance
 * check. Throws ENOENT for a missing script and EINVAL (the bundler's or the check's problems).
 */
export async function bundleNodeScript(
  files: FilesApi,
  script: string,
  esbuild: Esbuild,
): Promise<string> {
  const stats = await files.stats(script);
  if (stats?.kind !== "file") throw codedError("ENOENT", `no such file or directory, '${script}'`);
  let code: string;
  try {
    ({ code } = await bundle({
      esbuild,
      files,
      root: "/",
      entry: script,
      packages: nodeModulesPackages(),
      modules: (specifier) => NODE_MODULES[specifier],
      // The script's `console` is the isolate's, writing to stdout and stderr: named through
      // `__harness`, since a host may rebind the global `console` of loaded code (CellB does).
      // Its `fetch` is the egress gateway's, over the run's host (statewalker/statewalker-root#208):
      // named through `__harness` too, since a hardened realm may not let `fetch` be redefined.
      define: { console: "__harness.console", fetch: "__harness.fetch" },
      format: "esm",
      platform: "neutral",
      conditions: ["node", "worker", "browser"],
      target: "es2022",
      sourcemap: false,
      // No comments naming where the files live: the same script bundles to the same code (and
      // hash, which an operator approves on CellB Node) wherever it is.
      esbuildOptions: { minifyWhitespace: true, legalComments: "none" },
    }));
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).split("\n")[0];
    throw codedError("EINVAL", `${script} does not bundle: ${msg}`);
  }
  const problems = acceptBundle(code, { globals: NODE_GLOBALS });
  if (problems.length)
    throw codedError(
      "EACCES",
      `${script} reaches outside what a node script in an isolate may: ${problems.join("; ")}`,
    );
  return asFunction(code);
}

/**
 * The bundle as one async function, the module's default export: the script's top level runs
 * when the run calls it, not when the isolate loads its modules (workerd refuses I/O and timers in
 * a module's global scope). A script's own exports are dropped: nothing imports it.
 */
function asFunction(code: string): string {
  const body = code.replace(/export\s*\{[^}]*\};?\s*$/, "\n");
  return `export default async function main() {\n${body}\n}\n`;
}

/** The most a script reads at once, and lists, through its host. */
const MAX_READ = 32 * 1024 * 1024;
const MAX_LIST = 10_000;

/** The run's host calls over the session's file view (no databases), and its egress, if any. */
export function filesHostCalls(files: FilesApi, fetch?: ToolHostCalls["fetch"]): ToolHostCalls {
  const noDb = async (): Promise<never> => {
    throw codedError("ENOSYS", "a node script has no databases");
  };
  return {
    async read(path, start, length) {
      const parts: Uint8Array[] = [];
      let n = 0;
      const options = {
        ...(typeof start === "number" ? { start } : {}),
        ...(typeof length === "number" ? { length } : {}),
      };
      for await (const chunk of files.read(path, options)) {
        n += chunk.length;
        if (n > MAX_READ)
          throw codedError("EINVAL", `${path} is larger than a script may read at once`);
        parts.push(chunk);
      }
      const out = new Uint8Array(n);
      let at = 0;
      for (const p of parts) {
        out.set(p, at);
        at += p.length;
      }
      return out;
    },
    write: async (path, data) => {
      await files.write(path, [new Uint8Array(data)]);
    },
    mkdir: async (path) => {
      await files.mkdir(path);
    },
    async list(path, recursive) {
      const out: unknown[] = [];
      for await (const e of files.list(path, { recursive })) {
        out.push({ ...e });
        if (out.length > MAX_LIST) throw codedError("EINVAL", `${path} lists too many entries`);
      }
      return out;
    },
    stats: async (path) => (await files.stats(path)) ?? null,
    exists: (path) => files.exists(path),
    remove: (path) => files.remove(path),
    move: (source, target) => files.move(source, target),
    copy: (source, target) => files.copy(source, target),
    dbQuery: noDb,
    dbExec: noDb,
    ...(fetch ? { fetch } : {}),
  };
}

export interface NodeRun {
  /** The bundled script. */
  code: string;
  /** The script's path, as `process.argv[1]`. */
  script: string;
  args: string[];
  cwd: string;
  stdin?: string;
  env?: Record<string, string>;
  files: FilesApi;
  /** The run's egress (the gateway); absent: no network. */
  fetch?: ToolHostCalls["fetch"];
  timeoutMs: number;
  maxOutput: number;
  charge(ms: number): Promise<void>;
  record(ms: number): Promise<void>;
}

/** Runs a bundled `node` script in an isolate of its own: its output and exit code. */
export async function runNodeScript(
  loader: WorkerLoaderLike,
  run: NodeRun,
): Promise<{ stdout: string; stderr: string; exitCode: number; ms: number }> {
  const host = new ToolHost(filesHostCalls(run.files, run.fetch));
  const r = await runBundle(loader, {
    code: run.code,
    main: NODE_MAIN,
    input: {
      script: run.script,
      args: run.args,
      cwd: run.cwd,
      stdin: run.stdin ?? "",
      env: run.env ?? {},
      maxOutput: run.maxOutput,
    },
    host,
    timeoutMs: run.timeoutMs,
    maxOutput: run.maxOutput * 3,
    charge: run.charge,
    record: run.record,
  });
  if (r.isError) throw new Error(r.output);
  const out = JSON.parse(r.output) as { stdout: string; stderr: string; exitCode: number };
  return { ...out, ms: r.ms };
}
