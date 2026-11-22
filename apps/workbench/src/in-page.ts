// The page's side of the harness in this page (harness-worker.ts): a `fetch` onto it, streamed.
import type { DeploymentFetch } from "./client.js";

interface Pending {
  resolve(res: Response): void;
  reject(e: Error): void;
  body?: ReadableStreamDefaultController<Uint8Array>;
}

/** Starts the harness in a Dedicated Worker; resolves once it answers. */
export async function startInPageHarness(vars: Record<string, string>): Promise<DeploymentFetch> {
  const worker = new Worker(new URL("./harness-worker.ts", import.meta.url), { type: "module" });
  const pending = new Map<number, Pending>();
  let next = 0;
  const started = new Promise<void>((resolve, reject) => {
    pending.set(0, { resolve: () => resolve(), reject });
  });
  worker.addEventListener("message", (event) => {
    const msg = event.data;
    const entry = pending.get(msg.id);
    if (!entry) return;
    if (msg.type === "started") {
      pending.delete(0);
      entry.resolve(undefined as never);
    } else if (msg.type === "error") {
      pending.delete(msg.id);
      entry.reject(new Error(msg.message));
    } else if (msg.type === "head") {
      const stream = msg.body
        ? new ReadableStream<Uint8Array>({
            start: (c) => {
              entry.body = c;
            },
            cancel: () => {
              pending.delete(msg.id);
              worker.postMessage({ type: "cancel", id: msg.id });
            },
          })
        : null;
      if (!stream) pending.delete(msg.id);
      entry.resolve(
        new Response(stream, {
          status: msg.status,
          statusText: msg.statusText,
          headers: msg.headers,
        }),
      );
    } else if (msg.type === "chunk") entry.body?.enqueue(msg.chunk);
    else if (msg.type === "end") {
      pending.delete(msg.id);
      if (msg.error) entry.body?.error(new Error(msg.error));
      else entry.body?.close();
    }
  });
  worker.addEventListener("error", (e) => pending.get(0)?.reject(new Error(e.message)));
  const url = new URL("./harness/", document.baseURI).href;
  worker.postMessage({ type: "start", id: 0, url, vars });
  await started;
  return async (path, init) => {
    const req = new Request(new URL(path, "http://harness.local"), init);
    const body =
      req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
    const id = ++next;
    const answer = new Promise<Response>((resolve, reject) => pending.set(id, { resolve, reject }));
    worker.postMessage(
      { type: "request", id, url: req.url, method: req.method, headers: [...req.headers], body },
      body ? [body] : [],
    );
    return answer;
  };
}
