import { describe, expect, it } from "vitest";
import { createDefaultCatalog, mergeCatalogs } from "../../src/models/model-catalog.js";
import type { LocalModelConfig, ModelConfig } from "../../src/models/types.js";

describe("createDefaultCatalog", () => {
  it("returns a catalog of remote models", () => {
    const catalog = createDefaultCatalog();
    const keys = Object.keys(catalog);
    expect(keys.length).toBeGreaterThan(0);
    // Local entries are commented out while transformers.js is disabled.
    expect(keys.some((k) => k.startsWith("anthropic:"))).toBe(true);
    expect(keys.some((k) => k.startsWith("google:"))).toBe(true);
    expect(keys.some((k) => k.startsWith("openai:"))).toBe(true);
  });

  // Local-model assertions are disabled together with the catalog entries.
  // Re-enable when transformers.js is wired back in.
  it.skip("includes SmolLM2-135M, Qwen3.5-2B, and Llama-3.2-1B", () => {
    const catalog = createDefaultCatalog();
    expect(catalog["local:smollm2-135m"]).toBeDefined();
    expect(catalog["local:qwen3.5-2b"]).toBeDefined();
    expect(catalog["local:llama-3.2-1b"]).toBeDefined();
  });

  it.skip("local models have required fields", () => {
    const catalog = createDefaultCatalog();
    const local = catalog["local:qwen3.5-2b"] as LocalModelConfig;
    expect(local.runtime).toBe("local");
    expect(local.modelId).toBe("onnx-community/Qwen3.5-2B-ONNX");
    expect(local.dtype).toBe("q4");
    expect(local.sizeBytes).toBeGreaterThan(0);
    expect(local.family).toBe("Qwen 3.5");
  });

  it("remote models have required fields", () => {
    const catalog = createDefaultCatalog();
    const remote = catalog["anthropic:claude-sonnet"];
    expect(remote).toBeDefined();
    expect(remote?.runtime).toBe("remote");
    if (remote?.runtime === "remote") {
      expect(remote.provider).toBe("anthropic");
      expect(remote.modelId).toContain("claude");
    }
  });
});

describe("mergeCatalogs", () => {
  it("override replaces base entry with same key", () => {
    const base: Record<string, ModelConfig> = {
      "local:qwen": {
        runtime: "local",
        engine: "tjs",
        modelId: "qwen",
        label: "Qwen",
        family: "Qwen",
        dtype: "q4f16",
        size: "1 GB",
        sizeBytes: 1000,
        maxNewTokens: 512,
      },
    };
    const override: Record<string, ModelConfig> = {
      "local:qwen": {
        runtime: "local",
        engine: "tjs",
        modelId: "qwen",
        label: "Qwen",
        family: "Qwen",
        dtype: "q4f16",
        size: "1 GB",
        sizeBytes: 1000,
        maxNewTokens: 1024,
      },
    };
    const merged = mergeCatalogs(base, override);
    expect((merged["local:qwen"] as LocalModelConfig).maxNewTokens).toBe(1024);
  });

  it("override adds new entries", () => {
    const base: Record<string, ModelConfig> = {};
    const override: Record<string, ModelConfig> = {
      "custom:my-model": {
        runtime: "remote",
        provider: "openai",
        modelId: "my-custom",
        label: "Custom",
      },
    };
    const merged = mergeCatalogs(base, override);
    expect(merged["custom:my-model"]).toBeDefined();
  });

  it("base entries not in override are preserved", () => {
    const base: Record<string, ModelConfig> = {
      "openai:gpt-4o": {
        runtime: "remote",
        provider: "openai",
        modelId: "gpt-4o",
        label: "GPT-4o",
      },
    };
    const merged = mergeCatalogs(base, {});
    expect(merged["openai:gpt-4o"]).toBeDefined();
  });
});
