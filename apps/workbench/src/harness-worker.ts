// The harness in this page: the deployment (ai-host-do, built for browsers by `cellb build` into
// /harness/) loaded by @statewalker/cellb in this Dedicated Worker, its cells in the page's OPFS.
// It is a browser deployment (HOSTING "browser"): built without any deployment-held secret, it
// keeps only its user's own (statewalker/statewalker-root#132). The page reaches it only through
// the session API: requests come in as messages, answers go back as a head and body chunks.
import { loadProject } from "@statewalker/cellb/browser";
import { browserDeploymentConfig } from "@statewalker/ai-host-do/browser";
import { MemFilesApi } from "@statewalker/webrun-files-mem";

type LoadedProject = Awaited<ReturnType<typeof loadProject>>;

export interface StartMessage {
  type: "start";
  /** Where the built harness is: the page's ./harness/. */
  url: string;
  /** Variables over the built configuration: the page's own (an admin key it made, say). */
  vars: Record<string, string>;
}

let project: LoadedProject | undefined;
const bodies = new Map<number, ReadableStreamDefaultReader<Uint8Array>>();
const post = (message: unknown, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(message, transfer);

async function start({ url, vars }: StartMessage) {
  const base = new URL(url);
  const files = new MemFilesApi();
  const enc = new TextEncoder();
  for (const name of ["cellb.json", "worker.js", "wrangler.json"]) {
    const res = await fetch(new URL(name, base));
    if (!res.ok) throw new Error(`the harness is not built: ${name} answered ${res.status}`);
    let bytes = new Uint8Array(await res.arrayBuffer());
    if (name === "wrangler.json") {
      const config = JSON.parse(new TextDecoder().decode(bytes));
      // The build already made it a browser deployment's (scripts/build-harness.mjs); the page's
      // variables never add a deployment-held secret: HOSTING stays "browser".
      // The page's own admin key is the one held name it keeps; nothing else it passes can add a
      // deployment-held secret.
      Object.assign(config, browserDeploymentConfig(config, vars, { keep: ["ADMIN_KEY"] }));
      bytes = enc.encode(JSON.stringify(config));
    }
    await files.write(`/${name}`, [bytes]);
  }
  project = await loadProject(files as never, { data: "ai-workbench" });
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
  body?: ArrayBuffer;
}) {
  if (!project) throw new Error("the harness has not started");
  const init: RequestInit = { method: msg.method, headers: msg.headers };
  if (msg.body) init.body = msg.body;
  const res = await project.fetch(new Request(msg.url, init));
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
    if (msg.type === "start") {
      await start(msg);
      post({ type: "started", id: msg.id });
    } else if (msg.type === "request") await request(msg);
    else if (msg.type === "cancel") await bodies.get(msg.id)?.cancel();
  } catch (e) {
    post({ type: "error", id: msg.id, message: String((e as Error)?.message ?? e) });
  }
});
