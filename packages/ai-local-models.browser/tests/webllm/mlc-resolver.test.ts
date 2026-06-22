import type { LocalModelConfig } from "@statewalker/ai-agent.core/models";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMlcFiles, verifyMlcWeights } from "../../src/webllm/mlc-resolver.js";

const LLAMA_CONFIG: LocalModelConfig = {
  runtime: "local",
  engine: "webllm",
  modelId: "mlc-ai/Llama-3.2-1B-Instruct-q4f16_1-MLC",
  label: "Llama",
  family: "Llama",
  dtype: "q4f16_1",
  size: "880 MB",
  sizeBytes: 920_000_000,
  mlcModelLib: "https://example.com/libs/Llama-3.2-1B-webgpu.wasm",
};

describe("resolveMlcFiles", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns config, cache, shards, tokenizer, and wasm entries", async () => {
    const responses: Record<string, Response> = {
      "https://huggingface.co/mlc-ai/Llama-3.2-1B-Instruct-q4f16_1-MLC/resolve/main/mlc-chat-config.json":
        new Response(JSON.stringify({ tokenizer_files: ["tokenizer.json"] }), {
          status: 200,
        }),
      "https://huggingface.co/mlc-ai/Llama-3.2-1B-Instruct-q4f16_1-MLC/resolve/main/ndarray-cache.json":
        new Response(
          JSON.stringify({
            records: [
              { dataPath: "params_shard_0.bin", nbytes: 1024 },
              { dataPath: "params_shard_1.bin", nbytes: 2048 },
              { dataPath: "params_shard_0.bin", nbytes: 1024 },
            ],
          }),
          { status: 200 },
        ),
    };
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (responses[url]) return responses[url].clone();
      // HEAD / fallback
      return new Response("", {
        status: 200,
        headers: { "content-length": "0" },
      });
    }) as typeof fetch;

    const files = await resolveMlcFiles(LLAMA_CONFIG.modelId, LLAMA_CONFIG);
    const names = files.map((f) => f.name);
    expect(names).toContain("mlc-chat-config.json");
    expect(names).toContain("ndarray-cache.json");
    expect(names).toContain("params_shard_0.bin");
    expect(names).toContain("params_shard_1.bin");
    // deduped
    expect(names.filter((n) => n === "params_shard_0.bin")).toHaveLength(1);
    expect(names).toContain("tokenizer.json");
    expect(names).toContain("Llama-3.2-1B-webgpu.wasm");
  });
});

describe("verifyMlcWeights", () => {
  async function* iter<T>(items: T[]) {
    for (const i of items) yield i;
  }

  it("returns true when config + cache + shard all present", async () => {
    const ok = await verifyMlcWeights(
      iter([
        { kind: "file", name: "mlc-chat-config.json" },
        { kind: "file", name: "ndarray-cache.json" },
        { kind: "file", name: "params_shard_0.bin" },
      ]),
    );
    expect(ok).toBe(true);
  });

  it("returns false when a shard is missing", async () => {
    const ok = await verifyMlcWeights(
      iter([
        { kind: "file", name: "mlc-chat-config.json" },
        { kind: "file", name: "ndarray-cache.json" },
      ]),
    );
    expect(ok).toBe(false);
  });

  it("ignores directories and unrelated files", async () => {
    const ok = await verifyMlcWeights(
      iter([
        { kind: "directory", name: "something" },
        { kind: "file", name: "README.md" },
        { kind: "file", name: "mlc-chat-config.json" },
        { kind: "file", name: "ndarray-cache.json" },
        { kind: "file", name: "params_shard_0.bin" },
      ]),
    );
    expect(ok).toBe(true);
  });
});
