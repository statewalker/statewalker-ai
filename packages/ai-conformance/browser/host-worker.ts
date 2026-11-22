// One deployment on CellB in this Dedicated Worker: a `cellb build` folder loaded by
// @statewalker/cellb/browser, its cells in OPFS. The page relays the conformance runner's
// requests here and the answers back (host-page.ts); WebSockets the Worker accepts are relayed
// message by message.
import { installCodeEngines } from "@statewalker/ai-environment/code-engines";
import { installLocalEngine } from "@statewalker/ai-environment/local-models";
import { pyodideEngine, pyodideWorkerHost } from "@statewalker/ai-environment/pyodide";
import { loadProject } from "@statewalker/cellb/browser";

type LoadedProject = Awaited<ReturnType<typeof loadProject>>;

interface ServerSocket {
  accept(): void;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
}

// The page's local model engine (statewalker/statewalker-root#143), a stand-in for WebLLM: a
// model's "weights" are where the runner's scripted model answers for it, put here only by the
// runner's `download` (the user's action in the page).
const weights = new Map<string, string>();
installLocalEngine({
  has: async (model) => weights.has(model),
  async fetch(req) {
    const body = await req.text();
    const upstream = weights.get(String(JSON.parse(body).model));
    if (!upstream) return new Response("the model is not downloaded", { status: 404 });
    const path = new URL(req.url).pathname.replace(/^\/v1/, "");
    return fetch(`${upstream.replace(/\/+$/, "")}${path}`, {
      method: req.method,
      headers: req.headers,
      body,
    });
  },
});

// The page's code engines (statewalker/statewalker-root#142): Pyodide in a module Worker, its
// script served with a CSP that allows no eval and no other origin (src/browser-deployment.ts).
installCodeEngines({
  pyodide: pyodideEngine(
    pyodideWorkerHost({ engineUrl: "/engines/pyodide-engine.mjs", indexURL: "/pyodide/" }),
  ),
});

let project: LoadedProject | undefined;
let data = "";
const bodies = new Map<number, ReadableStreamDefaultReader<Uint8Array>>();
const sockets = new Map<number, ServerSocket>();

const post = (message: unknown, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(message, transfer);

async function removeData(name: string) {
  const root = await navigator.storage.getDirectory();
  for (const entry of [name, `${name}-files`])
    await root.removeEntry(entry, { recursive: true }).catch(() => {});
}

async function pump(id: number, reader: ReadableStreamDefaultReader<Uint8Array>) {
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.slice();
      post({ type: "chunk", id, chunk }, [chunk.buffer]);
    }
    post({ type: "end", id });
  } catch (e) {
    post({ type: "end", id, error: String((e as Error)?.message ?? e) });
  } finally {
    bodies.delete(id);
  }
}

async function request(msg: {
  id: number;
  url: string;
  method: string;
  headers: [string, string][];
  body?: Uint8Array;
}) {
  if (!project) throw new Error("no deployment");
  const init: RequestInit = { method: msg.method, headers: msg.headers };
  if (msg.body && msg.method !== "GET" && msg.method !== "HEAD") init.body = msg.body as BodyInit;
  const req = new Request(msg.url, init);
  // A browser drops Upgrade, Sec-* and Cookie from a Request's headers; a standalone Headers
  // keeps them, as CellB's own Request does for the Worker.
  Object.defineProperty(req, "headers", { value: new Headers(msg.headers), configurable: true });
  const res = await project.fetch(req);
  const ws = (res as Response & { webSocket?: ServerSocket | null }).webSocket;
  if (res.status === 101 && ws) {
    ws.accept();
    sockets.set(msg.id, ws);
    ws.addEventListener("message", (event) => {
      const d = event.data;
      if (typeof d === "string") post({ type: "ws-message", id: msg.id, data: d });
      else {
        const bytes =
          d instanceof ArrayBuffer
            ? new Uint8Array(d.slice(0))
            : new Uint8Array((d as Uint8Array).slice());
        post({ type: "ws-message", id: msg.id, data: bytes }, [bytes.buffer]);
      }
    });
    ws.addEventListener("close", () => {
      sockets.delete(msg.id);
      post({ type: "ws-close", id: msg.id });
    });
    post({ type: "head", id: msg.id, status: 101, headers: [], webSocket: true });
    return;
  }
  post({
    type: "head",
    id: msg.id,
    status: res.status,
    statusText: res.statusText,
    headers: [...res.headers],
    body: res.body !== null,
  });
  if (res.body) {
    const reader = res.body.getReader();
    bodies.set(msg.id, reader);
    void pump(msg.id, reader);
  }
}

self.addEventListener("message", async (event: MessageEvent) => {
  const msg = event.data;
  try {
    switch (msg.type) {
      case "start":
        data = msg.data;
        await removeData(data);
        project = await loadProject(new URL(msg.url, self.location.href), { data });
        post({ type: "started", id: msg.id, unsupported: project.unsupported });
        break;
      case "request":
        await request(msg);
        break;
      case "local-download":
        weights.set(msg.model, msg.scripted);
        post({ type: "downloaded", id: msg.id });
        break;
      case "cancel":
        await bodies.get(msg.id)?.cancel();
        break;
      case "ws-send":
        sockets.get(msg.id)?.send(msg.data);
        break;
      case "ws-close":
        sockets.get(msg.id)?.close(1000);
        sockets.delete(msg.id);
        break;
      case "close":
        await project?.close();
        project = undefined;
        await removeData(data);
        post({ type: "closed", id: msg.id });
        break;
    }
  } catch (e) {
    post({ type: "error", id: msg.id, message: String((e as Error)?.stack ?? e) });
  }
});
