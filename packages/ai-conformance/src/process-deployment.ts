// A deployment on CellD or on workerd, in a process of its own reached over HTTP: the Worker
// project bundled once per process by wrangler (`wrangler deploy --dry-run`, the bundle Cloudflare
// would get), then started per deployment from a folder of its own with its vars written into the
// folder's wrangler.json:
//   workerd  `wrangler dev` on that folder (local workerd through Miniflare)
//   celld    `celld dev` on that folder: the binary CELLD_BIN names, else the pinned Docker image
//            CELLD_IMAGE (host network, so the scripted model and the fake servers on 127.0.0.1
//            are reachable, and the temp folder, which holds the deployment folders, mounted at
//            its own path)
// Requests go over HTTP, WebSockets over Node's WebSocket client.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import {
  copyFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Deployment } from "./deployment.js";
import { projectConfig } from "./project-config.js";

const run = promisify(execFile);
const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const WRANGLER = join(PACKAGE, "node_modules", ".bin", "wrangler");

/**
 * celld 0.6.3, the release cellb's interop CI pins (statewalker/cellb.dev), by digest.
 * Bump it together with that pin.
 */
export const CELLD_IMAGE =
  "ghcr.io/denoland/celld:0.6.3@sha256:22bca1b40a9e4c434cc149d8913d7eaafa9792961a8c05f9fecf921d416216dc";

const quietEnv = () => ({
  ...process.env,
  WRANGLER_SEND_METRICS: "false",
  CI: process.env.CI ?? "true",
  NO_COLOR: "1",
});

// ---- the bundle, once per project per process -----------------------------------------------------

const bundles = new Map<string, Promise<string>>();
let buildRoot: string | undefined;

function root(): string {
  if (!buildRoot) {
    const dir = mkdtempSync(join(tmpdir(), "ai-conformance-bundles-"));
    process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
    buildRoot = dir;
  }
  return buildRoot;
}

/** The project bundled by wrangler: worker.js, its .wasm modules, and wrangler.json (no_bundle). */
function bundle(projectDir: string): Promise<string> {
  let out = bundles.get(projectDir);
  if (!out) {
    out = (async () => {
      const dir = join(root(), `project-${bundles.size}`);
      mkdirSync(dir);
      const config = projectConfig(projectDir);
      const source = join(dir, "source.json");
      writeFileSync(source, JSON.stringify({ ...config, main: join(projectDir, config.main) }));
      const target = join(dir, "bundle");
      await run(WRANGLER, ["deploy", "--dry-run", "--outdir", target, "-c", source], {
        cwd: dir,
        env: quietEnv(),
        maxBuffer: 64 * 1024 * 1024,
      });
      for (const f of readdirSync(target)) if (!/\.(m?js|wasm)$/.test(f)) rmSync(join(target, f));
      writeFileSync(
        join(target, "wrangler.json"),
        JSON.stringify({ ...config, main: "worker.js", no_bundle: true }),
      );
      return target;
    })();
    bundles.set(projectDir, out);
  }
  return out;
}

// ---- the processes --------------------------------------------------------------------------------

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

const children = new Set<() => void>();
process.once("exit", () => {
  for (const kill of children) kill();
});

let counter = 0;

interface Started {
  child: ChildProcess;
  /** Stops what `child` started beyond itself (a container). */
  stop?: () => Promise<void>;
  kill?: () => void;
}

function startCelld(folder: string, port: number): Started {
  const args = ["dev", ".", "--host", "127.0.0.1", "--port", String(port), "--no-watch", "--clean"];
  const bin = process.env.CELLD_BIN;
  if (bin)
    return {
      child: spawn(bin, args, { cwd: join(folder, "app"), env: quietEnv(), detached: true }),
    };
  const image = process.env.CELLD_IMAGE || CELLD_IMAGE;
  const name = `ai-conformance-${process.pid}-${++counter}`;
  const tmp = tmpdir();
  const user =
    typeof process.getuid === "function"
      ? ["--user", `${process.getuid()}:${process.getgid?.()}`]
      : [];
  const child = spawn(
    "docker",
    [
      "run",
      "--rm",
      "--name",
      name,
      "--network",
      "host",
      ...user,
      "-e",
      `HOME=${tmp}`,
      "-v",
      `${tmp}:${tmp}`,
      "-w",
      join(folder, "app"),
      image,
      ...args,
    ],
    { env: quietEnv(), detached: true },
  );
  const remove = () =>
    run("docker", ["rm", "--force", name]).then(
      () => {},
      () => {},
    );
  return {
    child,
    stop: remove,
    kill: () => {
      try {
        execFile("docker", ["rm", "--force", name]);
      } catch {}
    },
  };
}

function startWorkerd(folder: string, port: number): Started {
  const child = spawn(
    WRANGLER,
    [
      "dev",
      "-c",
      join(folder, "app", "wrangler.json"),
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--persist-to",
      join(folder, "state"),
      "--show-interactive-dev-session=false",
      "--log-level",
      "warn",
    ],
    // Wrangler's own log files go with the folder. A process group of its own: wrangler starts
    // workerd, and both stop together.
    {
      cwd: folder,
      env: { ...quietEnv(), WRANGLER_LOG_PATH: join(folder, "logs") },
      detached: true,
    },
  );
  return { child };
}

async function waitReady(origin: string, child: ChildProcess, logs: string[]): Promise<void> {
  // Starting is bounded by the first answer, not by a clock: a loaded machine is only slower.
  // Each failed attempt waits a little; the process exiting ends the wait.
  for (let attempt = 0; ; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(
        `the deployment exited (${child.exitCode ?? child.signalCode}):\n${logs.join("").slice(-6000)}`,
      );
    try {
      const res = await fetch(origin, { signal: AbortSignal.timeout(5000) });
      await res.body?.cancel();
      return;
    } catch {}
    if (attempt > 2000)
      throw new Error(`the deployment never answered:\n${logs.join("").slice(-6000)}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * A folder of its own for one deployment: `app/` holds the bundle's files and wrangler.json with
 * `vars`; the runtime's state and logs go beside it, never into the folder wrangler watches.
 */
function deploymentFolder(bundled: string, vars: Record<string, string>): string {
  const folder = mkdtempSync(join(tmpdir(), "ai-conformance-"));
  const app = join(folder, "app");
  mkdirSync(app);
  for (const f of readdirSync(bundled)) {
    if (f === "wrangler.json") continue;
    try {
      linkSync(join(bundled, f), join(app, f));
    } catch {
      copyFileSync(join(bundled, f), join(app, f));
    }
  }
  const config = JSON.parse(readFileSync(join(bundled, "wrangler.json"), "utf8"));
  config.vars = { ...config.vars, ...vars };
  writeFileSync(join(app, "wrangler.json"), JSON.stringify(config, null, 1));
  return folder;
}

/** Starts the Worker project on CellD or workerd, each deployment a process of its own. */
export async function startProcessDeployment(
  runtime: "celld" | "workerd",
  projectDir: URL,
  vars: Record<string, string> = {},
): Promise<Deployment> {
  const bundled = await bundle(fileURLToPath(projectDir));
  // A port picked free can be taken before the runtime binds it (other runs share the machine):
  // then the start is tried again on another port.
  for (let attempt = 1; ; attempt++) {
    const folder = deploymentFolder(bundled, vars);
    try {
      return await startIn(runtime, folder);
    } catch (e) {
      rmSync(folder, { recursive: true, force: true });
      if (attempt >= 5 || !/address already in use|EADDRINUSE/i.test(String(e))) throw e;
    }
  }
}

async function startIn(runtime: "celld" | "workerd", folder: string): Promise<Deployment> {
  const port = await freePort();
  const started = runtime === "celld" ? startCelld(folder, port) : startWorkerd(folder, port);
  const { child } = started;
  const logs: string[] = [];
  const sink = (d: Buffer) => {
    logs.push(d.toString());
    if (logs.length > 400) logs.splice(0, logs.length - 400);
    if (process.env.CONFORMANCE_LOGS) process.stderr.write(d);
  };
  child.stdout?.on("data", sink);
  child.stderr?.on("data", sink);
  /** Signals the runtime's whole process group (wrangler and its workerd). */
  const signal = (sig: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, sig);
    } catch {
      child.kill(sig);
    }
  };
  const kill = () => {
    started.kill?.();
    signal("SIGKILL");
  };
  children.add(kill);
  const origin = `http://127.0.0.1:${port}`;
  const stop = async () => {
    children.delete(kill);
    await started.stop?.();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((r) => child.once("exit", r));
      signal("SIGTERM");
      const timer = setTimeout(() => signal("SIGKILL"), 5000);
      await exited;
      clearTimeout(timer);
    }
    // Whatever the runtime left of its group.
    signal("SIGKILL");
  };
  try {
    await waitReady(origin, child, logs);
  } catch (e) {
    await stop();
    throw e;
  }
  return {
    fetch: (path, init) => httpFetch(new URL(path, origin), init),
    close: async () => {
      await stop();
      rmSync(folder, { recursive: true, force: true });
    },
  };
}

// ---- requests -------------------------------------------------------------------------------------

function headerOf(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

async function httpFetch(url: URL, init?: RequestInit): Promise<Response> {
  if (headerOf(init, "upgrade")?.toLowerCase() === "websocket") return openSocket(url, init);
  const body = init?.body;
  return fetch(url, {
    redirect: "manual",
    ...init,
    ...(body && typeof (body as ReadableStream).getReader === "function" ? { duplex: "half" } : {}),
  } as RequestInit);
}

type Listener = (event: { data?: unknown; code?: number; reason?: string }) => void;

/**
 * Node's WebSocket client in the shape the runner's clients take from CellB (`accept()`, then the
 * WebSocket API): messages and close events are held until `accept()`.
 */
class ClientSocket {
  readonly #ws: WebSocket;
  #accepted = false;
  readonly #held: [string, { data?: unknown }][] = [];
  readonly #listeners = new Map<string, Set<Listener>>();
  constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.binaryType = "arraybuffer";
    for (const type of ["message", "close", "error"]) {
      ws.addEventListener(type, (event) => {
        const e = event as unknown as { data?: unknown; code?: number; reason?: string };
        const copy = { data: e.data, code: e.code, reason: e.reason };
        if (this.#accepted) this.#emit(type, copy);
        else this.#held.push([type, copy]);
      });
    }
  }
  get readyState() {
    return this.#ws.readyState;
  }
  get binaryType() {
    return "arraybuffer";
  }
  set binaryType(_value: string) {}
  accept() {
    if (this.#accepted) return;
    this.#accepted = true;
    for (const [type, event] of this.#held.splice(0)) this.#emit(type, event);
  }
  send(data: string | ArrayBuffer | ArrayBufferView | Blob) {
    if (this.#ws.readyState !== 1) return;
    this.#ws.send(data as never);
  }
  close(code?: number, reason?: string) {
    if (this.#ws.readyState >= 2) return;
    this.#ws.close(code ?? 1000, reason);
  }
  #emit(type: string, event: { data?: unknown }) {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) listener(event);
  }
  addEventListener(type: string, listener: Listener) {
    const set = this.#listeners.get(type) ?? new Set<Listener>();
    this.#listeners.set(type, set);
    set.add(listener);
  }
  removeEventListener(type: string, listener: Listener) {
    this.#listeners.get(type)?.delete(listener);
  }
}

/** The status a refused upgrade answers, read with a plain HTTP request carrying the same headers. */
function refusedStatus(url: URL, init?: RequestInit): Promise<number> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString(
        "base64",
      ),
    };
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const req = httpRequest(url, { headers });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 500);
    });
    req.on("upgrade", (_res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on("error", () => resolve(502));
    req.end();
  });
}

async function openSocket(url: URL, init?: RequestInit): Promise<Response> {
  const wsUrl = new URL(url);
  wsUrl.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => {
    if (!["upgrade", "connection"].includes(k) && !k.startsWith("sec-websocket")) headers[k] = v;
  });
  // Node's WebSocket (undici) takes extra handshake headers through its options.
  const ws = new WebSocket(wsUrl, { headers } as never);
  const socket = new ClientSocket(ws);
  const opened = await new Promise<boolean>((resolve) => {
    ws.addEventListener("open", () => resolve(true), { once: true });
    ws.addEventListener("error", () => resolve(false), { once: true });
    ws.addEventListener("close", () => resolve(false), { once: true });
  });
  if (!opened) {
    const status = await refusedStatus(url, init);
    return new Response(null, { status: status === 101 ? 502 : status });
  }
  const res = new Response(null, { status: 200 });
  Object.defineProperty(res, "status", { value: 101 });
  Object.defineProperty(res, "webSocket", { value: socket });
  return res;
}
