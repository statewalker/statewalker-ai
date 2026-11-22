// The page between the conformance runner (Node, through Playwright) and the deployments, each in
// a Dedicated Worker of its own (host-worker.ts). The runner calls `window.cellbHost` with
// page.evaluate; everything a worker sends back goes to the runner's binding `cellbHostEvent`.
declare global {
  interface Window {
    cellbHost: CellbHost;
    cellbHostEvent(deployment: string, message: unknown): Promise<void>;
  }
}

interface CellbHost {
  start(deployment: string, url: string): Promise<{ unsupported: string[] }>;
  /** The user downloads a local model's weights (the stand-in engine's: see host-worker.ts). */
  localDownload(deployment: string, model: string, scripted: string): Promise<void>;
  post(deployment: string, message: Record<string, unknown>): void;
  close(deployment: string): Promise<void>;
}

function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

const workers = new Map<string, Worker>();
const waiting = new Map<string, (message: { type: string; message?: string }) => void>();

function call(deployment: string, message: Record<string, unknown>) {
  const worker = workers.get(deployment);
  if (!worker) return Promise.reject(new Error(`no deployment ${deployment}`));
  return new Promise<{ type: string; unsupported?: string[] }>((resolve, reject) => {
    waiting.set(deployment, (answer) =>
      answer.type === "error" ? reject(new Error(answer.message)) : resolve(answer),
    );
    worker.postMessage({ ...message, id: -1 });
  });
}

window.cellbHost = {
  async start(deployment, url) {
    const worker = new Worker(new URL("./host-worker.ts", import.meta.url), { type: "module" });
    workers.set(deployment, worker);
    worker.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg.id === -1) {
        waiting.get(deployment)?.(msg);
        waiting.delete(deployment);
        return;
      }
      // Bytes cross Playwright's binding as base64.
      const out = { ...msg };
      if (out.chunk) out.chunk = toBase64(out.chunk as Uint8Array);
      if (out.data instanceof Uint8Array) out.data = { bytes: toBase64(out.data) };
      void window.cellbHostEvent(deployment, out);
    });
    worker.addEventListener("error", (event) =>
      waiting.get(deployment)?.({ type: "error", message: event.message }),
    );
    const answer = await call(deployment, {
      type: "start",
      url,
      data: `ai-conformance-${deployment}`,
    });
    return { unsupported: answer.unsupported ?? [] };
  },
  async localDownload(deployment, model, scripted) {
    await call(deployment, { type: "local-download", model, scripted });
  },
  post(deployment, message) {
    const out = { ...message };
    if (typeof out.body === "string") out.body = fromBase64(out.body);
    const data = out.data as { bytes?: string } | undefined;
    if (data && typeof data === "object" && typeof data.bytes === "string")
      out.data = fromBase64(data.bytes);
    workers.get(deployment)?.postMessage(out);
  },
  async close(deployment) {
    if (!workers.has(deployment)) return;
    await call(deployment, { type: "close" }).catch(() => {});
    workers.get(deployment)?.terminate();
    workers.delete(deployment);
  },
};

export {};
