// The `isolate` executor for native tool scripts (statewalker/statewalker-root#130, decided in #94):
// each call loads the tool's bundle into a Worker Loader isolate of its own, with the network off
// (`globalOutbound: null`) and nothing in its `env`; the script reaches files and its databases
// only through the host the call drives, which answers only while the run lasts (the run lease)
// and acts with the capability the Workspace DO gives it. The isolate's time is charged as the run
// goes (`charge`), and the run is ended when a charge is refused or its timeout passes: the lease
// is revoked, the script's signal aborts, and the call answers at once.
//
// The script reaches the host through a stub handed to `run(input, host)`, where a stub crosses
// into a loaded isolate (workerd, CellB). CellD's Worker Loader carries an RPC argument by
// structured clone only (statewalker/statewalker-root#141), so there the host's calls cross as
// plain values instead: the host starts the run (`start(input)`), each answer of the isolate is
// either the run's end or the host calls the script waits on, and the host answers those
// (`resume(answers)`) to get the next. Which form a runtime takes is probed once per isolate with
// a loaded worker holding no tool code. (workerd would not take that second form: a promise of one
// call settled by the next counts there as a hung request.) The script sees the same `ctx` either way.
//
// Inside the isolate, a wrapper module removes the host's reach from the realm before the bundle
// is evaluated (the Node realm CellB runs isolates in has `process`; workerd's has `fetch`), then
// calls the script's `execute(input, ctx)` with `ctx = {files, db, signal, log}`.
import { RpcTarget } from "cloudflare:workers";
import type { WorkerLoaderLike } from "./env.js";

/** What a script reaches through `ctx`, acted on by the host with the tool's capability. */
export interface ToolHostCalls {
  read(path: string, start?: number, length?: number): Promise<Uint8Array>;
  write(path: string, data: Uint8Array): Promise<void>;
  mkdir(path: string): Promise<void>;
  list(path: string, recursive: boolean): Promise<unknown[]>;
  stats(path: string): Promise<unknown>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<boolean>;
  move(source: string, target: string): Promise<boolean>;
  copy(source: string, target: string): Promise<boolean>;
  dbQuery(database: string, sql: string, params: unknown[]): Promise<unknown>;
  dbExec(database: string, sql: string): Promise<void>;
  /**
   * One request through the egress gateway (statewalker/statewalker-root#208): the isolate's only
   * network (its `globalOutbound` stays null). Absent: no network at all.
   */
  fetch?(request: HostFetchRequest): Promise<HostFetchResponse>;
}

/** A request an isolate's script hands the gateway: the body as bytes. */
export interface HostFetchRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: Uint8Array;
}

/** What the gateway answers an isolate's script. */
export interface HostFetchResponse {
  status: number;
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

const HOST_METHODS = new Set<string>([
  "read",
  "write",
  "mkdir",
  "list",
  "stats",
  "exists",
  "remove",
  "move",
  "copy",
  "dbQuery",
  "dbExec",
  "fetch",
]);

/** The host a run drives: each call checks the run's lease first. */
export class ToolHost extends RpcTarget {
  #calls: ToolHostCalls | undefined;
  constructor(calls: ToolHostCalls) {
    super();
    this.#calls = calls;
  }
  /** One call the script asked for, by name: only the host's own methods. */
  invoke(method: string, args: unknown): Promise<unknown> {
    if (!HOST_METHODS.has(method))
      return Promise.reject(new Error(`ENOSYS: no host call '${method}'`));
    const a = Array.isArray(args) ? args : [];
    return Promise.resolve().then(() =>
      (this as unknown as Record<string, (...x: unknown[]) => unknown>)[method]?.(...a),
    );
  }
  /** Ends the lease: every later call is refused. */
  revoke(): void {
    this.#calls = undefined;
  }
  #live(): ToolHostCalls {
    if (!this.#calls) throw new Error("EACCES: the tool's run has ended");
    return this.#calls;
  }
  read(path: string, start?: number, length?: number) {
    return this.#live().read(String(path), start, length);
  }
  write(path: string, data: Uint8Array) {
    return this.#live().write(String(path), data);
  }
  mkdir(path: string) {
    return this.#live().mkdir(String(path));
  }
  list(path: string, recursive: boolean) {
    return this.#live().list(String(path), !!recursive);
  }
  stats(path: string) {
    return this.#live().stats(String(path));
  }
  exists(path: string) {
    return this.#live().exists(String(path));
  }
  remove(path: string) {
    return this.#live().remove(String(path));
  }
  move(source: string, target: string) {
    return this.#live().move(String(source), String(target));
  }
  copy(source: string, target: string) {
    return this.#live().copy(String(source), String(target));
  }
  dbQuery(database: string, sql: string, params: unknown[]) {
    return this.#live().dbQuery(String(database), String(sql), Array.isArray(params) ? params : []);
  }
  dbExec(database: string, sql: string) {
    return this.#live().dbExec(String(database), String(sql));
  }
  fetch(request: HostFetchRequest) {
    const calls = this.#live();
    if (!calls.fetch)
      return Promise.reject(new Error("EACCES: this run has no network (the egress gateway)"));
    return calls.fetch(request);
  }
}

/** Removes the host's reach from the isolate's realm, before the bundle is evaluated. */
export const HARDEN = `
for (const name of ["process", "require", "module", "exports", "Buffer", "global", "fetch",
  "connect", "caches", "WebAssembly", "eval", "importScripts", "Worker", "SharedWorker",
  "XMLHttpRequest", "WebSocket", "EventSource", "Deno", "Bun"]) {
  try { delete globalThis[name]; } catch {}
  try { if (name in globalThis) Object.defineProperty(globalThis, name, { value: undefined }); } catch {}
}
// Every kind of function's constructor compiles code from text: none is reachable.
for (const f of [function () {}, async function () {}, function* () {}, async function* () {}])
  Object.defineProperty(Object.getPrototypeOf(f), "constructor", { value: undefined });
`;

/**
 * How a run's script reaches the host by plain values (CellD): `host` queues its calls, `next()`
 * answers the run's end or the calls queued; `outcome`, `notify` and `waiting` are the entrypoint's.
 */
export const PLUMBING = `
// The host's calls: queued here as plain values, handed to the host by the answer of start() or
// resume(), and settled by the next resume().
let nextCall = 0;
const queued = [];
const waiting = new Map();
let outcome;
let wake;
const notify = () => { const w = wake; wake = undefined; w?.(); };
const host = new Proxy({}, {
  get: (_, method) => (...args) => new Promise((resolve, reject) => {
    const id = ++nextCall;
    waiting.set(id, { resolve, reject });
    queued.push({ id, method: String(method), args });
    notify();
  }),
});
/** The run's end, or the host calls queued since the last answer (several at once, when made together). */
async function next() {
  for (;;) {
    if (outcome) return { done: outcome };
    if (queued.length) {
      await new Promise((r) => setTimeout(r, 0));
      return { calls: queued.splice(0) };
    }
    await new Promise((r) => { wake = r; });
  }
}
`;

/**
 * The egress gateway as a script sees it (statewalker/statewalker-root#208): a `fetch` over the
 * run's host, plain values only (on CellB Node the realm's own Request and Response need Buffer,
 * which the hardened realm no longer has). The isolate's own globalOutbound stays null.
 */
export const GATEWAY_FETCH = `
function gatewayFetchOf(host) {
  return async (resource, init = {}) => {
      // Plain values only: on CellB Node the realm's own Request and Response need Buffer, which
      // the hardened realm no longer has.
      const url = typeof resource === "string" ? resource : String(resource?.url ?? resource);
      const method = String(init.method ?? resource?.method ?? "GET").toUpperCase();
      const headers = {};
      const given = init.headers ?? resource?.headers;
      if (given && typeof given.forEach === "function") given.forEach((v, k) => { headers[String(k).toLowerCase()] = String(v); });
      else if (Array.isArray(given)) for (const [k, v] of given) headers[String(k).toLowerCase()] = String(v);
      else if (given) for (const [k, v] of Object.entries(given)) headers[k.toLowerCase()] = String(v);
      let body;
      const b = init.body;
      if (b === undefined || b === null) body = undefined;
      else if (typeof b === "string") body = new TextEncoder().encode(b);
      else if (b instanceof Uint8Array) body = b;
      else if (b instanceof ArrayBuffer) body = new Uint8Array(b);
      else if (ArrayBuffer.isView(b)) body = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
      else if (b instanceof URLSearchParams) { body = new TextEncoder().encode(String(b)); headers["content-type"] ??= "application/x-www-form-urlencoded;charset=UTF-8"; }
      else body = new TextEncoder().encode(String(b));
      if (typeof b === "string") headers["content-type"] ??= "text/plain;charset=UTF-8";
      let r;
      try {
        r = await host.fetch({ url, method, headers, ...(body && body.length ? { body } : {}) });
      } catch (e) {
        throw new TypeError("fetch failed: " + String(e?.message ?? e));
      }
      const bytes = new Uint8Array(r.body ?? []);
      const resHeaders = new Map(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
      let used = false;
      const take = () => { if (used) throw new TypeError("the body was already read"); used = true; return bytes; };
      return {
        status: r.status,
        ok: r.status >= 200 && r.status < 300,
        statusText: "",
        url: r.url,
        redirected: false,
        headers: {
          get: (k) => resHeaders.get(String(k).toLowerCase()) ?? null,
          has: (k) => resHeaders.has(String(k).toLowerCase()),
          forEach: (f) => resHeaders.forEach((v, k) => f(v, k)),
          entries: () => resHeaders.entries(),
          keys: () => resHeaders.keys(),
          values: () => resHeaders.values(),
          [Symbol.iterator]: () => resHeaders.entries(),
        },
        get bodyUsed() { return used; },
        text: async () => new TextDecoder().decode(take()),
        json: async () => JSON.parse(new TextDecoder().decode(take())),
        arrayBuffer: async () => take().slice().buffer,
        bytes: async () => take().slice(),
      };
    };
}
`;

/** The isolate's main module: the entrypoint the host calls. */
const MAIN = `
import { WorkerEntrypoint } from "cloudflare:workers";
import "./harden.js";
import * as tool from "./tool.js";

const controller = new AbortController();
const MAX_LOGS = 100;
const logs = [];
const text = (v) => { try { return typeof v === "string" ? v : JSON.stringify(v); } catch { return String(v); } };
const log = (...args) => { if (logs.length < MAX_LOGS) logs.push(args.map(text).join(" ").slice(0, 2000)); };
for (const level of ["debug", "info", "warn", "error"]) log[level] = log;

${PLUMBING}
${GATEWAY_FETCH}
const filesOf = (host) => ({
  async *read(path, options) {
    const data = await host.read(path, options?.start, options?.length);
    if (data && data.byteLength) yield new Uint8Array(data);
  },
  async write(path, content) {
    const parts = [];
    let n = 0;
    for await (const c of content) { const b = typeof c === "string" ? new TextEncoder().encode(c) : c; parts.push(b); n += b.length; }
    const all = new Uint8Array(n);
    let at = 0;
    for (const p of parts) { all.set(p, at); at += p.length; }
    await host.write(path, all);
  },
  mkdir: (path) => host.mkdir(path),
  async *list(path, options) { for (const e of await host.list(path, !!options?.recursive)) yield e; },
  stats: async (path) => (await host.stats(path)) ?? undefined,
  exists: (path) => host.exists(path),
  remove: (path) => host.remove(path),
  move: (source, target) => host.move(source, target),
  copy: (source, target) => host.copy(source, target),
});

const dbOf = (host) => (name) => ({
  query: (sql, params) => host.dbQuery(String(name), String(sql), params ?? []),
  exec: (sql) => host.dbExec(String(name), String(sql)),
});

/** An OpenCode-style tool's args (JSON Schema, a Standard Schema, or a record of either) as JSON Schema. */
function jsonSchemaOf(args) {
  if (!args || typeof args !== "object") return { type: "object", properties: {} };
  const std = args["~standard"];
  if (std) {
    if (typeof std.jsonSchema?.input === "function") return std.jsonSchema.input({ target: "draft-2020-12" });
    throw new Error("its args are a Standard Schema without a JSON Schema");
  }
  if (typeof args.type === "string") return args;
  const properties = {};
  const required = [];
  for (const [key, field] of Object.entries(args)) {
    properties[key] = field?.["~standard"] ? jsonSchemaOf(field) : field;
    const optional = typeof field?.isOptional === "function" ? field.isOptional() : false;
    if (!optional && field?.["~standard"]) required.push(key);
  }
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

async function validated(args, input) {
  if (!args || typeof args !== "object") return input;
  const check = async (schema, value, where) => {
    const v = schema?.["~standard"]?.validate;
    if (typeof v !== "function") return value;
    const r = await v(value);
    if (r.issues) throw new Error("invalid arguments" + where + ": " + r.issues.map((i) => i.message).join("; "));
    return r.value;
  };
  if (args["~standard"]) return check(args, input, "");
  if (typeof args.type === "string") return input;
  const out = { ...input };
  for (const [key, field] of Object.entries(args)) out[key] = await check(field, input?.[key], " (" + key + ")");
  return out;
}

export default class extends WorkerEntrypoint {
  ready() { return true; }
  abort(reason) { controller.abort(new Error(String(reason))); }
  describe() {
    const m = tool.default;
    if (!m || typeof m !== "object" || typeof m.execute !== "function")
      throw new Error("an OpenCode-style tool default-exports {description, args, execute}");
    return { description: String(m.description ?? ""), args: jsonSchemaOf(m.args) };
  }
  run(input, stub) {
    return this.#run(input, stub);
  }
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
    const m = tool.default;
    const execute = typeof m === "function" ? m : typeof m?.execute === "function" ? m.execute.bind(m) : undefined;
    if (!execute) return { ok: false, error: "the script exports no execute function", logs };
    const ctx = { files: filesOf(host), db: dbOf(host), fetch: gatewayFetchOf(host), signal: controller.signal, log };
    try {
      const args = typeof m === "function" ? input : await validated(m.args, input);
      const out = await execute(args, ctx);
      return { ok: true, output: typeof out === "string" ? out : JSON.stringify(out ?? null), logs };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e), logs };
    }
  }
}
`;

type RunOutcome = { ok: boolean; output?: string; error?: string; logs?: string[] };
type HostCall = { id: number; method: string; args: unknown[] };
type HostAnswer =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string };
/** What the isolate answers start() and resume() with. */
type RunStep = { done: RunOutcome } | { calls: HostCall[] };

interface ToolEntrypoint {
  ready(): Promise<boolean>;
  abort(reason: string): Promise<void>;
  describe(): Promise<{ description: string; args: Record<string, unknown> }>;
  run(input: unknown, host: ToolHost): Promise<RunOutcome>;
  start(input: unknown): Promise<RunStep>;
  resume(answers: HostAnswer[]): Promise<RunStep>;
}

/** A loaded worker with no tool code in it: it only takes a stub, to see whether one crosses. */
const PROBE = `
import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint {
  accepts(stub) { return true; }
}
`;

/** A stub with nothing behind it, for the probe. */
class ProbeTarget extends RpcTarget {}

/**
 * Whether this runtime's Worker Loader carries a stub into a loaded isolate, found once per
 * isolate with the probe, never from a call a tool script runs in: a script controls its own
 * result, and could make it fail as an unclonable value.
 */
let stubsCross: Promise<boolean> | undefined;

/** A refusal to carry a stub into the loaded isolate (CellD). */
const refusedStub = (e: unknown) =>
  (e as Error)?.name === "DataCloneError" ||
  /could not be cloned|Could not serialize|supports only Service Binding/.test(
    String((e as Error)?.message ?? e),
  );

function probeStubs(loader: WorkerLoaderLike): Promise<boolean> {
  stubsCross ??= (async () => {
    const worker = loader.load({
      compatibilityDate: COMPATIBILITY_DATE,
      mainModule: "probe.js",
      modules: { "probe.js": PROBE },
      env: {},
      globalOutbound: null,
    });
    try {
      const entry = worker.getEntrypoint() as unknown as {
        accepts(stub: unknown): Promise<boolean>;
      };
      return (await entry.accepts(new ProbeTarget())) === true;
    } catch (e) {
      if (refusedStub(e)) return false;
      throw e;
    } finally {
      try {
        worker.dispose?.();
      } catch {}
    }
  })();
  // A probe that failed otherwise (the loader itself) is tried again by the next run.
  stubsCross.catch(() => {
    stubsCross = undefined;
  });
  return stubsCross;
}

/** Runs the script with the host as a stub where stubs cross, else drives it call by call. */
async function drive(
  loader: WorkerLoaderLike,
  entry: ToolEntrypoint,
  input: unknown,
  host: ToolHost,
): Promise<RunOutcome> {
  return (await probeStubs(loader)) ? entry.run(input, host) : driveByValues(entry, input, host);
}

/** Drives one run by plain values: answers the host calls the script waits on until it ends. */
async function driveByValues(
  entry: ToolEntrypoint,
  input: unknown,
  host: ToolHost,
): Promise<RunOutcome> {
  let step = await entry.start(input);
  while (!("done" in step)) {
    const answers = await Promise.all(
      (Array.isArray(step.calls) ? step.calls : []).map(
        async ({ id, method, args }): Promise<HostAnswer> => {
          try {
            return { id, ok: true, value: await host.invoke(String(method), args) };
          } catch (e) {
            return { id, ok: false, error: String((e as Error)?.message ?? e) };
          }
        },
      ),
    );
    step = await entry.resume(answers);
  }
  return step.done;
}

const COMPATIBILITY_DATE = "2026-10-01";

/** Loads a bundle into an isolate of its own; `dispose` releases it once the call ended. */
function load(
  loader: WorkerLoaderLike,
  code: string,
  main: string = MAIN,
): { entry: ToolEntrypoint; dispose(): void } {
  const worker = loader.load({
    compatibilityDate: COMPATIBILITY_DATE,
    mainModule: "main.js",
    modules: { "main.js": main, "harden.js": HARDEN, "tool.js": code },
    env: {},
    globalOutbound: null,
  });
  return {
    entry: worker.getEntrypoint() as ToolEntrypoint,
    dispose: () => {
      try {
        // CellB keeps the isolate's thread until its runtime closes (statewalker/cellb.dev#206).
        worker.dispose?.();
      } catch {}
    },
  };
}

/** Waits for `p` at most `ms`, rejecting with `message` after. */
function within<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** What an OpenCode-style tool says of itself: its bundle evaluated in an isolate. */
export async function describeBundle(loader: WorkerLoaderLike, code: string, timeoutMs = 10_000) {
  const { entry, dispose } = load(loader, code);
  try {
    return await within(
      entry.describe(),
      timeoutMs,
      "ETIMEDOUT: the tool did not describe itself in time",
    );
  } finally {
    dispose();
  }
}

export interface ToolRun {
  code: string;
  input: unknown;
  host: ToolHost;
  timeoutMs: number;
  /** The most output a call answers, in characters. */
  maxOutput?: number;
  /** Charges isolate time as the run goes; throws (ELIMIT) to end it. */
  charge(ms: number): Promise<void>;
  /** Records the time left once the run ended (never refused). */
  record(ms: number): Promise<void>;
  /**
   * The isolate's main module, when not a tool's (a `node` script's runtime, ./node-runner.ts): it
   * imports `./harden.js` first and `./tool.js` (the code) when it runs, and answers the same
   * entrypoint (`ready`, `abort`, `run`, `start`, `resume`).
   */
  main?: string;
}

/** How often a running call's time is charged. */
const SLICE_MS = 100;
const MAX_OUTPUT = 1024 * 1024;

/** Runs one call of a tool bundle in an isolate of its own (see the top of this file). */
export async function runBundle(
  loader: WorkerLoaderLike,
  run: ToolRun,
): Promise<{ output: string; isError: boolean; ms: number }> {
  const started = Date.now();
  const result = await runIn(loader, run);
  return { ...result, ms: Date.now() - started };
}

async function runIn(
  loader: WorkerLoaderLike,
  run: ToolRun,
): Promise<{ output: string; isError: boolean }> {
  const { entry, dispose } = load(loader, run.code, run.main);
  try {
    // Loading is not the script's time: the isolate is up before the clock starts.
    await within(entry.ready(), 30_000, "ETIMEDOUT: the tool's isolate did not start");
    await run.charge(1);
  } catch (e) {
    run.host.revoke();
    dispose();
    return { output: String((e as Error)?.message ?? e), isError: true };
  }
  const started = Date.now();
  // Time charged (or recorded) so far; a refused slice was spent all the same, and is recorded
  // once the run ended, so the next run is refused at once.
  let charged = 1;
  let charging: Promise<unknown> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const ended = new Promise<string>((resolve) => {
    deadline = setTimeout(
      () => resolve(`ETIMEDOUT: the tool ran longer than ${run.timeoutMs} ms`),
      run.timeoutMs,
    );
    timer = setInterval(() => {
      if (charging) return;
      const slice = Date.now() - started - charged;
      if (slice <= 0) return;
      charging = run.charge(slice).then(
        () => {
          charged += slice;
          charging = undefined;
        },
        (e) => resolve(String((e as Error)?.message ?? e)),
      );
    }, SLICE_MS);
  });
  try {
    const outcome = await Promise.race([
      drive(loader, entry, run.input, run.host).then((r) => ({ r })),
      ended.then((killed) => ({ killed })),
    ]);
    if ("killed" in outcome) {
      // Ended: nothing it does from now on reaches anything, and it is told to stop.
      run.host.revoke();
      void Promise.resolve()
        .then(() => entry.abort(outcome.killed))
        .catch(() => {});
      return { output: outcome.killed, isError: true };
    }
    const { r } = outcome;
    const logs = r.logs?.length ? `\nlog:\n${r.logs.join("\n")}` : "";
    if (!r.ok) return { output: `${r.error ?? "the tool failed"}${logs}`, isError: true };
    const output = String(r.output ?? "null");
    if (output.length > (run.maxOutput ?? MAX_OUTPUT))
      return {
        output: `EINVAL: the tool's output is larger than ${run.maxOutput ?? MAX_OUTPUT} characters`,
        isError: true,
      };
    return { output, isError: false };
  } catch (e) {
    return { output: String((e as Error)?.message ?? e), isError: true };
  } finally {
    clearInterval(timer);
    clearTimeout(deadline);
    run.host.revoke();
    dispose();
    await charging;
    const rest = Date.now() - started - charged;
    if (rest > 0) await run.record(rest).catch(() => {});
  }
}
