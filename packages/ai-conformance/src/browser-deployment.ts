// A deployment on CellB in Chromium: the Worker project built by `cellb build`, loaded by
// @statewalker/cellb/browser in a Dedicated Worker of a page Playwright drives, its cells in OPFS.
// The runner reaches it through the page: requests go in with page.evaluate, answers (streamed
// bodies and WebSocket messages included) come back through a binding. The page and its worker
// are built once per process with Vite (browser/), the project with `cellb build`.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { browserDeploymentConfig } from "@statewalker/ai-host-do/browser";
import type { Browser, Page } from "playwright";
import type { Deployment } from "./deployment.js";

const run = promisify(execFile);
const HERE = fileURLToPath(new URL(".", import.meta.url));
const PACKAGE = join(HERE, "..");
/** Pyodide and the engine script, served to the page's Python engine (statewalker/statewalker-root#142). */
const PYODIDE_DIR = fileURLToPath(new URL(".", import.meta.resolve("pyodide/pyodide.mjs")));
/** The engine scripts sit in `engines/` beside the package's modules (src/ or dist/). */
const engineScript = (name: string) =>
  fileURLToPath(
    new URL(`../engines/${name}`, import.meta.resolve("@statewalker/ai-environment/pyodide")),
  );
const PYODIDE_ENGINE = engineScript("pyodide-engine.mjs");
/** The Wasmer engine script and the SDK's package folder (`dist/`, `pkg/`), served likewise. */
const WASMER_ENGINE = engineScript("wasmer-engine.mjs");
const WASMER_SDK = join(fileURLToPath(new URL(".", import.meta.resolve("@wasmer/sdk"))), "..");

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".css": "text/css",
};

// ---- what is built once per process --------------------------------------------------------------

interface Built {
  dir: string;
  page: string;
  projects: Map<string, Promise<string>>;
}
let built: Promise<Built> | undefined;

function buildPage(): Promise<Built> {
  built ??= (async () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-conformance-browser-"));
    process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
    const page = join(dir, "page");
    const vite = join(PACKAGE, "node_modules", ".bin", "vite");
    await run(
      vite,
      ["build", "--config", join(PACKAGE, "browser", "vite.config.ts"), "--outDir", page],
      {
        cwd: PACKAGE,
      },
    );
    return { dir, page, projects: new Map() };
  })();
  return built;
}

/** The project folder built for browsers by `cellb build`, once per project per process. */
async function buildProject(projectDir: string): Promise<string> {
  const b = await buildPage();
  let out = b.projects.get(projectDir);
  if (!out) {
    const target = join(b.dir, `project-${b.projects.size}`);
    const cellb = join(PACKAGE, "node_modules", ".bin", "cellb");
    out = run(cellb, ["build", projectDir, "--out", target], { cwd: PACKAGE }).then(() => target);
    b.projects.set(projectDir, out);
  }
  return out;
}

// ---- the static server and the browser, shared by the deployments of a process --------------------

interface Shared {
  server: Server;
  origin: string;
  browser: Browser;
  /** Per deployment: its built folder and the wrangler.json it is started with. */
  deployments: Map<string, { folder: string; config: string }>;
  users: number;
}
let shared: Promise<Shared> | undefined;

async function launch(): Promise<Browser> {
  const { chromium } = await import("playwright");
  // The deployment's outbound requests (the scripted model, the fake REST and S3 servers) go to
  // other local ports: cross-origin for the page, so same-origin checks are off in this browser.
  // Same-origin checks off also turns cross-origin isolation off: shared memory, which the Wasmer
  // engine's bridge needs (a real page gets it by COOP/COEP), is turned on by its own flag.
  const args = ["--disable-web-security", "--enable-features=SharedArrayBuffer"];
  const executablePath = process.env.CONFORMANCE_CHROMIUM || undefined;
  try {
    return await chromium.launch({ executablePath, args });
  } catch (e) {
    if (executablePath) throw e;
    // No Playwright browser downloaded: an installed Chrome will do.
    return chromium.launch({ channel: "chrome", args });
  }
}

function startShared(): Promise<Shared> {
  shared ??= (async () => {
    const b = await buildPage();
    const deployments = new Map<string, { folder: string; config: string }>();
    const server = createServer((req, res) => {
      const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
      let file: string | undefined;
      const m = /^\/deployments\/([^/]+)\/(.*)$/.exec(path);
      if (m) {
        const d = deployments.get(String(m[1]));
        if (d && m[2] === "wrangler.json") {
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(d.config);
          return;
        }
        if (d) file = join(d.folder, normalize(`/${m[2]}`));
      } else if (path.startsWith("/pyodide/"))
        file = join(PYODIDE_DIR, normalize(`/${path.slice("/pyodide/".length)}`));
      else if (path === "/engines/pyodide-engine.mjs") {
        file = PYODIDE_ENGINE;
        // The engine's Worker: no eval, no other origin (its network is gone after Pyodide loads).
        res.setHeader(
          "content-security-policy",
          "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'",
        );
      } else if (path === "/engines/wasmer-engine.mjs") file = WASMER_ENGINE;
      else if (path.startsWith("/wasmer/sdk/"))
        file = join(WASMER_SDK, normalize(`/${path.slice("/wasmer/sdk/".length)}`));
      else file = join(b.page, normalize(path === "/" ? "/index.html" : path));
      try {
        const body = readFileSync(String(file));
        res.writeHead(200, {
          "content-type": TYPES[extname(String(file))] ?? "application/octet-stream",
          "cache-control": "no-store",
        });
        res.end(body);
      } catch {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { server, origin, browser: await launch(), deployments, users: 0 };
  })();
  return shared;
}

async function releaseShared(s: Shared): Promise<void> {
  if (--s.users > 0) return;
  shared = undefined;
  await s.browser.close().catch(() => {});
  await new Promise<void>((resolve) => s.server.close(() => resolve()));
}

// ---- the bridge ----------------------------------------------------------------------------------

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const unb64 = (text: string) => new Uint8Array(Buffer.from(text, "base64"));

interface Pending {
  head(message: HeadMessage): void;
  fail(error: Error): void;
  body?: ReadableStreamDefaultController<Uint8Array>;
  socket?: BridgedSocket;
}

interface HeadMessage {
  type: "head";
  id: number;
  status: number;
  statusText?: string;
  headers: [string, string][];
  body?: boolean;
  webSocket?: boolean;
}

type Listener = (event: { data?: unknown }) => void;

/** The runner's end of a WebSocket the deployment's Worker accepted, relayed by the page. */
class BridgedSocket {
  readyState = 0;
  binaryType = "arraybuffer";
  readonly #listeners = new Map<string, Set<Listener>>();
  constructor(
    readonly send_: (data: unknown) => void,
    readonly close_: () => void,
  ) {}
  accept() {
    this.readyState = 1;
  }
  send(data: string | ArrayBuffer | Uint8Array | Blob) {
    if (this.readyState !== 1) return;
    if (typeof data === "string") this.send_(data);
    else if (data instanceof ArrayBuffer) this.send_({ bytes: b64(new Uint8Array(data)) });
    else if (data instanceof Uint8Array) this.send_({ bytes: b64(data) });
    else throw new Error("the bridged WebSocket sends strings and bytes only");
  }
  close() {
    if (this.readyState >= 2) return;
    this.close_();
    this.closed();
  }
  closed() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", {});
  }
  emit(type: string, event: { data?: unknown }) {
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

let counter = 0;

/**
 * Starts the Worker project in `projectDir` on CellB in Chromium, with `vars` over its
 * configuration as a browser deployment takes them (`browserDeploymentConfig`: no deployment-held secrets).
 */
export async function startBrowserDeployment(
  projectDir: URL,
  vars: Record<string, string> = {},
): Promise<Deployment> {
  const dir = fileURLToPath(projectDir);
  const folder = await buildProject(dir);
  const s = await startShared();
  s.users++;
  const name = `d${process.pid}-${++counter}`;
  const config = JSON.parse(readFileSync(join(folder, "wrangler.json"), "utf8"));
  s.deployments.set(name, {
    folder,
    config: JSON.stringify(
      browserDeploymentConfig(config, vars, {
        // The run's own admin key, for its test-only routes.
        keep: ["ADMIN_KEY"],
      }),
    ),
  });
  let page: Page | undefined;
  const pending = new Map<number, Pending>();
  let next = 0;
  try {
    page = await s.browser.newPage();
    const p = page;
    page.on("pageerror", (e) => {
      // pi-ai probes node:fs, node:os and node:path where `process` looks like Node's; a browser
      // has none, and pi-ai copes.
      if (/dynamically imported module: node:/.test(e.message)) return;
      console.error(`[browser ${name}]`, e);
    });
    await page.exposeBinding("cellbHostEvent", (_source, _deployment: string, msg) => {
      const entry = pending.get(msg.id);
      if (!entry) return;
      switch (msg.type) {
        case "head":
          entry.head(msg as HeadMessage);
          break;
        case "chunk":
          try {
            entry.body?.enqueue(unb64(msg.chunk));
          } catch {}
          break;
        case "end":
          pending.delete(msg.id);
          try {
            if (msg.error) entry.body?.error(new Error(msg.error));
            else entry.body?.close();
          } catch {}
          break;
        case "error":
          pending.delete(msg.id);
          entry.fail(new Error(msg.message));
          break;
        case "ws-message": {
          const data = typeof msg.data === "string" ? msg.data : unb64(msg.data.bytes).buffer;
          entry.socket?.emit("message", { data });
          break;
        }
        case "ws-close":
          pending.delete(msg.id);
          entry.socket?.closed();
          break;
      }
    });
    await page.goto(`${s.origin}/index.html`);
    await page.waitForFunction(() => "cellbHost" in globalThis);
    await page.evaluate(
      ([d, url]) => (globalThis as unknown as HostWindow).cellbHost.start(d, url),
      [name, `${s.origin}/deployments/${name}/`] as const,
    );

    const post = (message: Record<string, unknown>) =>
      p
        .evaluate(([d, m]) => (globalThis as unknown as HostWindow).cellbHost.post(d, m), [
          name,
          message,
        ] as const)
        .catch(() => {});

    const deployment: Deployment = {
      async fetch(path, init) {
        const req = new Request(new URL(path, "http://localhost"), init);
        const body =
          req.method === "GET" || req.method === "HEAD"
            ? undefined
            : new Uint8Array(await req.arrayBuffer());
        const id = ++next;
        const answer = new Promise<Response>((resolve, reject) => {
          const entry: Pending = {
            fail: reject,
            head(head) {
              if (head.webSocket) {
                entry.socket = new BridgedSocket(
                  (data) => void post({ type: "ws-send", id, data }),
                  () => void post({ type: "ws-close", id }),
                );
                resolve({
                  status: 101,
                  headers: new Headers(),
                  webSocket: entry.socket,
                } as unknown as Response);
                return;
              }
              const nullBody = [101, 204, 205, 304].includes(head.status) || !head.body;
              const stream = nullBody
                ? null
                : new ReadableStream<Uint8Array>({
                    start: (c) => {
                      entry.body = c;
                    },
                    cancel: () => {
                      pending.delete(id);
                      void post({ type: "cancel", id });
                    },
                  });
              if (nullBody) pending.delete(id);
              resolve(
                new Response(stream, {
                  status: head.status,
                  statusText: head.statusText,
                  headers: head.headers,
                }),
              );
            },
          };
          pending.set(id, entry);
        });
        await post({
          type: "request",
          id,
          url: req.url,
          method: req.method,
          headers: [...req.headers],
          body: body ? b64(body) : undefined,
        });
        return answer;
      },
      localModels: {
        async download(model, scripted) {
          await p.evaluate(
            ([d, m, sc]) => (globalThis as unknown as HostWindow).cellbHost.localDownload(d, m, sc),
            [name, model, scripted] as const,
          );
        },
      },
      async close() {
        try {
          await p
            .evaluate((d) => (globalThis as unknown as HostWindow).cellbHost.close(d), name)
            .catch(() => {});
          await p.close().catch(() => {});
        } finally {
          s.deployments.delete(name);
          await releaseShared(s);
        }
      },
    };
    return deployment;
  } catch (e) {
    await page?.close().catch(() => {});
    s.deployments.delete(name);
    await releaseShared(s);
    throw e;
  }
}

/** What the host page (browser/host-page.ts) puts on its window. */
interface HostWindow {
  cellbHost: {
    start(deployment: string, url: string): Promise<{ unsupported: string[] }>;
    localDownload(deployment: string, model: string, scripted: string): Promise<void>;
    post(deployment: string, message: Record<string, unknown>): void;
    close(deployment: string): Promise<void>;
  };
}
