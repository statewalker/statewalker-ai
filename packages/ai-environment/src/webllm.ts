// The `local` provider's WebLLM engine (statewalker/statewalker-root#143), ported from the removed
// `@statewalker/ai-local-models.browser`: MLC models on WebGPU in the user's browser page, behind
// the model gateway as an OpenAI-compatible endpoint (WebLLM's own API is OpenAI's). The page
// installs it (`installLocalEngine(webllmEngine(...))`) before it starts the deployment.
//
// Weights are downloaded only by `download`, the user's action in the page; WebLLM keeps them in
// the browser's cache. A request runs only on a model in that cache: the engine loads it from
// there and never fetches weights for a request.
//
// `@mlc-ai/web-llm` is not a dependency of this package: the page passes `load` (usually
// `() => import("@mlc-ai/web-llm")`), so nothing here pulls in WebLLM unless a page uses it.

import type { LocalEngine } from "./local-models.js";

/** WebLLM's load progress (`InitProgressReport`). */
export interface WebLlmProgress {
  progress: number;
  text: string;
  timeElapsed?: number;
}

/** The part of WebLLM's `MLCEngine` the adapter uses. */
export interface WebLlmMlcEngine {
  reload(model: string): Promise<void>;
  setInitProgressCallback?(callback: (report: WebLlmProgress) => void): void;
  interruptGenerate(): void;
  chat: { completions: { create(request: Record<string, unknown>): Promise<unknown> } };
}

/** The part of the `@mlc-ai/web-llm` module the adapter uses. */
export interface WebLlmModule {
  CreateMLCEngine(
    model: string,
    config?: { appConfig?: unknown; initProgressCallback?: (report: WebLlmProgress) => void },
  ): Promise<WebLlmMlcEngine>;
  hasModelInCache(model: string, appConfig?: unknown): Promise<boolean>;
  deleteModelAllInfoInCache?(model: string, appConfig?: unknown): Promise<void>;
}

export interface WebLlmEngineOptions {
  /** Loads WebLLM's module: `() => import("@mlc-ai/web-llm")`. */
  load: () => Promise<WebLlmModule>;
  /** WebLLM's `AppConfig` (its model list), when not its prebuilt one. */
  appConfig?: unknown;
}

/** The engine, plus the page's side: the user's downloads. */
export interface WebLlmEngine extends LocalEngine {
  /** Downloads a model's weights into the browser's cache: the user's action, never a request's. */
  download(model: string, onProgress?: (report: WebLlmProgress) => void): Promise<void>;
  /** Deletes a model's weights from the browser's cache. */
  remove(model: string): Promise<void>;
}

/** The OpenAI request fields WebLLM honours; anything else is dropped. */
const FIELDS = [
  "messages",
  "tools",
  "tool_choice",
  "temperature",
  "top_p",
  "stop",
  "seed",
  "frequency_penalty",
  "presence_penalty",
  "stream",
  "stream_options",
  "response_format",
] as const;

type Part = { type?: string; text?: string };
const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? (content as Part[]).map((p) => (p?.type === "text" ? (p.text ?? "") : "")).join("")
      : "";

/** An OpenAI chat request as WebLLM takes it: text content, a system role, `max_tokens`. */
export function webllmRequest(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of FIELDS) if (body[key] !== undefined) out[key] = body[key];
  const max = body.max_tokens ?? body.max_completion_tokens;
  if (typeof max === "number") out.max_tokens = max;
  out.messages = ((body.messages as Record<string, unknown>[] | undefined) ?? []).map((m) => {
    const role = m.role === "developer" ? "system" : m.role;
    const { content, ...rest } = m;
    // WebLLM takes string content for system, assistant and tool messages; text-only models have
    // nothing to do with image parts.
    return { ...rest, role, content: textOf(content) };
  });
  return out;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A local engine running WebLLM in this page (or its worker). */
export function webllmEngine(options: WebLlmEngineOptions): WebLlmEngine {
  let module: Promise<WebLlmModule> | undefined;
  const webllm = () => {
    module ??= options.load();
    return module;
  };
  let engine: WebLlmMlcEngine | undefined;
  let loaded: string | undefined;
  // WebLLM runs one generation at a time: requests and downloads queue.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };
  const load = async (model: string, onProgress?: (report: WebLlmProgress) => void) => {
    if (engine && loaded === model) return engine;
    if (engine) {
      engine.setInitProgressCallback?.(onProgress ?? (() => {}));
      await engine.reload(model);
    } else
      engine = await (await webllm()).CreateMLCEngine(model, {
        ...(options.appConfig !== undefined ? { appConfig: options.appConfig } : {}),
        ...(onProgress ? { initProgressCallback: onProgress } : {}),
      });
    loaded = model;
    return engine;
  };
  const has = async (model: string) => {
    try {
      return await (await webllm()).hasModelInCache(model, options.appConfig);
    } catch {
      // WebLLM throws for a model its app config does not list: not here, then.
      return false;
    }
  };

  return {
    has,
    download: (model, onProgress) =>
      serial(async () => {
        await load(model, onProgress);
      }),
    remove: (model) =>
      serial(async () => {
        if (loaded === model) loaded = undefined;
        await (await webllm()).deleteModelAllInfoInCache?.(model, options.appConfig);
      }),
    async fetch(request) {
      if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/chat/completions"))
        return json(404, { error: { message: "only POST /chat/completions" } });
      const body = (await request.json()) as Record<string, unknown>;
      const model = String(body.model ?? "");
      return serial(async () => {
        // Checked again here, in the queue: a request never loads a model the cache lacks.
        if (!(await has(model)))
          return json(404, {
            error: { message: `ENOENT: ${model} is not downloaded in this browser` },
          });
        try {
          const e = await load(model);
          const onAbort = () => e.interruptGenerate();
          request.signal?.addEventListener("abort", onAbort);
          const answer = await e.chat.completions.create(webllmRequest(body));
          if (!body.stream) {
            request.signal?.removeEventListener("abort", onAbort);
            return json(200, answer);
          }
          // Read to the end inside the queue, so the next request waits for this generation.
          const enc = new TextEncoder();
          const frames: Uint8Array[] = [];
          try {
            for await (const chunk of answer as AsyncIterable<unknown>)
              frames.push(enc.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          } finally {
            request.signal?.removeEventListener("abort", onAbort);
          }
          frames.push(enc.encode("data: [DONE]\n\n"));
          const sse = new ReadableStream<Uint8Array>({
            start(c) {
              for (const f of frames) c.enqueue(f);
              c.close();
            },
          });
          return new Response(sse, {
            headers: { "content-type": "text/event-stream" },
          });
        } catch (e) {
          return json(500, { error: { message: String((e as Error)?.message ?? e) } });
        }
      });
    },
  };
}
