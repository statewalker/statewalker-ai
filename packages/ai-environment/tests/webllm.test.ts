// The WebLLM engine of the `local` provider (statewalker/statewalker-root#143): a browser page's
// WebLLM behind the model gateway. WebLLM needs WebGPU and gigabytes of weights, which no test
// run has, so it is replaced here by a stand-in of its module (the `CreateMLCEngine` and
// `hasModelInCache` the adapter calls), and the adapter is driven through the gateway, the way the
// harness reaches it. The conformance suite drives the gateway's side in a real browser.
import { normalizeContext } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  checkModelsConfig,
  ModelGateway,
  type ModelMeter,
  type ModelUsage,
  resolveModels,
} from "../src/index.js";
import { type WebLlmModule, webllmEngine } from "../src/webllm.js";

type Chunk = Record<string, unknown>;

/** WebLLM's module, faked: a cache of downloaded models and an engine answering `answer`. */
function fakeWebLlm(answer: { text?: string; toolCall?: { name: string; args: string } } = {}) {
  const cached = new Set<string>();
  const log = { created: [] as string[], reloaded: [] as string[], requests: [] as Chunk[] };
  const chunks = (): Chunk[] => {
    const out: Chunk[] = [];
    if (answer.text)
      out.push({ choices: [{ index: 0, delta: { role: "assistant", content: answer.text } }] });
    if (answer.toolCall)
      out.push({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: answer.toolCall.name, arguments: answer.toolCall.args },
                },
              ],
            },
          },
        ],
      });
    out.push({
      choices: [{ index: 0, delta: {}, finish_reason: answer.toolCall ? "tool_calls" : "stop" }],
    });
    out.push({ choices: [], usage: { prompt_tokens: 21, completion_tokens: 5, total_tokens: 26 } });
    return out;
  };
  const engine = {
    async reload(model: string) {
      // Loading a model not in the cache downloads it.
      log.reloaded.push(model);
      cached.add(model);
    },
    interruptGenerate() {},
    chat: {
      completions: {
        async create(request: Chunk) {
          log.requests.push(request);
          const all = chunks();
          if (!request.stream)
            return {
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: answer.text ?? "" },
                  finish_reason: "stop",
                },
              ],
              usage: { prompt_tokens: 21, completion_tokens: 5 },
            };
          return (async function* () {
            yield* all;
          })();
        },
      },
    },
  };
  const module: WebLlmModule = {
    async CreateMLCEngine(model, config) {
      log.created.push(model);
      config?.initProgressCallback?.({ progress: 1, text: `loaded ${model}`, timeElapsed: 0 });
      cached.add(model);
      return engine;
    },
    async hasModelInCache(model) {
      return cached.has(model);
    },
  };
  return { module, cached, log };
}

const MODEL = "Hermes-3-Llama-3.1-8B-q4f16_1-MLC";
const { catalog } = resolveModels([
  {
    level: "deployment",
    config: checkModelsConfig({
      providers: [{ id: "local", api: "local" }],
      models: [{ id: `local/${MODEL}`, maxTokens: 512 }],
    }),
  },
]);
const pinned = { catalog, model: `local/${MODEL}`, fallbacks: [] };
const meta = { session: "as-1", user: "ann", project: "home" };
const context = {
  systemPrompt: "SYSTEM-PROMPT",
  messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

function gatewayWith(module: WebLlmModule) {
  const usage: ModelUsage[] = [];
  const meter: ModelMeter = { record: (u) => void usage.push(u) };
  const engine = webllmEngine({ load: async () => module });
  const gateway = new ModelGateway({ secrets: async () => undefined, meter, local: engine });
  return { engine, gateway, usage };
}

describe("the WebLLM engine", () => {
  it("never downloads weights for a request: a model not in the cache is unavailable", async () => {
    const { module, log } = fakeWebLlm({ text: "hi" });
    const { gateway, engine } = gatewayWith(module);
    expect(await engine.has(MODEL)).toBe(false);
    const res = await gateway.request(pinned, { context }, () => true, meta);
    expect(res.attempts).toMatchObject([{ usage: { outcome: "unavailable" } }]);
    expect(res.message.errorMessage).toMatch(/ENOENT.*download/);
    expect(log.created).toEqual([]);
    expect(log.reloaded).toEqual([]);
    // Even asked directly, the engine refuses a model it does not hold.
    const direct = await engine.fetch(
      new Request("http://local-engine.invalid/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(direct.status).toBe(404);
    expect(log.created).toEqual([]);
  });

  it("downloads a model's weights when the user asks, reporting progress", async () => {
    const { module, log } = fakeWebLlm();
    const { engine } = gatewayWith(module);
    const progress: number[] = [];
    await engine.download(MODEL, (p) => progress.push(p.progress));
    expect(log.created).toEqual([MODEL]);
    expect(progress).toEqual([1]);
    expect(await engine.has(MODEL)).toBe(true);
  });

  it("answers a downloaded model's requests in the page: text, tool calls and usage", async () => {
    const { module, cached, log } = fakeWebLlm({
      text: "Hello from the page",
      toolCall: { name: "read", args: '{"path":"/a"}' },
    });
    cached.add(MODEL);
    const { gateway, usage } = gatewayWith(module);
    const res = await gateway.request(
      pinned,
      {
        // The harness's context: pi-ai's, normalized (system prompt and tools as its first message).
        context: normalizeContext({
          ...context,
          tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
        } as never) as never,
        maxTokens: 100,
      },
      () => true,
      meta,
    );
    expect(res.message).toMatchObject({
      stopReason: "toolUse",
      content: [
        { type: "text", text: "Hello from the page" },
        { type: "toolCall", name: "read", arguments: { path: "/a" } },
      ],
    });
    expect(usage).toMatchObject([
      {
        model: `local/${MODEL}`,
        provider: "local",
        input_tokens: 21,
        output_tokens: 5,
        outcome: "ok",
      },
    ]);
    // Loaded from the cache, once; WebLLM got the OpenAI request with the system prompt as text.
    expect(log.created).toEqual([MODEL]);
    const request = log.requests[0] as {
      messages: { role: string; content: unknown }[];
      tools?: unknown[];
      max_tokens?: number;
      stream?: boolean;
    };
    expect(request.messages[0]).toEqual({ role: "system", content: "SYSTEM-PROMPT" });
    expect(request.messages.every((m) => typeof m.content === "string")).toBe(true);
    expect(request.tools).toHaveLength(1);
    expect(request.max_tokens).toBe(100);
    expect(request.stream).toBe(true);
  });

  it("reaches no address but its own engine", async () => {
    const { module, cached } = fakeWebLlm({ text: "hi" });
    cached.add(MODEL);
    const { gateway } = gatewayWith(module);
    // The provider's configured base URL and headers are not used for a local model.
    const { catalog: other } = resolveModels([
      {
        level: "user",
        config: checkModelsConfig({
          providers: [
            {
              id: "local",
              api: "local",
              baseUrl: "https://attacker.example/v1",
              headers: { "x-leak": "1" },
            },
          ],
          models: [{ id: `local/${MODEL}` }],
        }),
      },
    ]);
    const net = vi.spyOn(globalThis, "fetch");
    try {
      const res = await gateway.request(
        { catalog: other, model: `local/${MODEL}`, fallbacks: [] },
        { context },
        () => true,
        meta,
      );
      expect(res.attempts).toMatchObject([{ usage: { outcome: "ok", charged: false } }]);
      expect(net).not.toHaveBeenCalled();
    } finally {
      net.mockRestore();
    }
  });
});
