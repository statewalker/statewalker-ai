import { describe, expect, it, vi } from "vitest";
import { ModelStateStore } from "../../src/models/model-state-store.js";
import type { ModelConfig } from "../../src/models/types.js";
import { UnifiedProvider } from "../../src/models/unified-provider.js";

const REMOTE_MODEL: ModelConfig = {
  runtime: "remote",
  provider: "openai",
  modelId: "gpt-test",
  label: "GPT Test",
};

describe("UnifiedProvider", () => {
  it("delegates languageModel to store.getLanguageModel", () => {
    const store = new ModelStateStore({ "remote:test": REMOTE_MODEL });
    const mockModel = { specificationVersion: "v3" as const } as never;
    vi.spyOn(store, "getLanguageModel").mockReturnValue(mockModel);

    const provider = new UnifiedProvider(store);
    const result = provider.languageModel("remote:test");

    expect(store.getLanguageModel).toHaveBeenCalledWith("remote:test");
    expect(result).toBe(mockModel);
  });

  it("throws when model not activated", () => {
    const store = new ModelStateStore({ "remote:test": REMOTE_MODEL });
    const provider = new UnifiedProvider(store);

    expect(() => provider.languageModel("remote:test")).toThrow(/not ready/);
  });

  it("throws for imageModel", () => {
    const store = new ModelStateStore({});
    const provider = new UnifiedProvider(store);

    expect(() => provider.imageModel("any")).toThrow();
  });

  it("throws for embeddingModel on local models", () => {
    const store = new ModelStateStore({
      "local:test": {
        runtime: "local",
        engine: "tjs",
        modelId: "test",
        label: "Test",
        family: "Test",
        dtype: "q4",
        size: "1 GB",
        sizeBytes: 1000,
      },
    });
    const provider = new UnifiedProvider(store);

    expect(() => provider.embeddingModel("local:test")).toThrow();
  });
});
