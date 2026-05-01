import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelManager } from "../src/model-manager.js";
import { ModelStateStore } from "../src/model-state-store.js";
import type { RemoteModelConfig } from "../src/types.js";

function makeManager(seed: Record<string, RemoteModelConfig> = {}): {
  manager: ModelManager;
  store: ModelStateStore;
} {
  const store = new ModelStateStore(seed);
  const manager = new ModelManager({ store });
  return { manager, store };
}

describe("ModelManager.testConnection", () => {
  afterEach(() => vi.restoreAllMocks());

  it("dispatches to listModels without touching the store", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      async json() {
        return { data: [{ id: "gpt-4o" }] };
      },
      async text() {
        return "";
      },
    } as unknown as Response);

    const { manager, store } = makeManager();
    let notified = false;
    store.onUpdate(() => {
      notified = true;
    });

    const result = await manager.testConnection("openai", { apiKey: "k" });

    expect(result).toEqual([{ id: "gpt-4o", label: "gpt-4o" }]);
    expect(notified).toBe(false);
    expect(Object.keys(store.catalog)).toEqual([]);
  });
});

describe("ModelManager.importDiscoveredModels", () => {
  it("adds new entries with kinds=['reasoning'] and persists provider settings", () => {
    const { manager, store } = makeManager();

    const addedKeys = manager.importDiscoveredModels(
      "anthropic",
      null,
      [
        { id: "claude-sonnet-4-20250514", label: "Sonnet 4" },
        { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
      ],
      { apiKey: "sk-ant" },
    );

    expect(addedKeys).toEqual([
      "anthropic/claude-sonnet-4-20250514",
      "anthropic/claude-haiku-4-5-20251001",
    ]);

    const sonnet = store.catalog["anthropic/claude-sonnet-4-20250514"];
    expect(sonnet).toMatchObject({
      runtime: "remote",
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      label: "Sonnet 4",
      kinds: ["reasoning"],
    });
    expect((sonnet as RemoteModelConfig).providerInstanceId).toBeUndefined();

    expect(store.getProviderSettings("anthropic")).toEqual({
      apiKey: "sk-ant",
    });
    expect(store.getState("anthropic/claude-sonnet-4-20250514")?.status).toBe("not-downloaded");
  });

  it("scopes openai-compatible entries with providerInstanceId", () => {
    const { manager, store } = makeManager();

    const addedKeys = manager.importDiscoveredModels(
      "openai-compatible",
      "groq",
      [{ id: "llama-3.1-70b-versatile", label: "Llama 3.1 70B" }],
      {
        apiKey: "gsk",
        baseURL: "https://api.groq.com/openai/v1",
      },
    );

    expect(addedKeys).toEqual(["openai-compatible:groq/llama-3.1-70b-versatile"]);
    const cfg = store.catalog[
      "openai-compatible:groq/llama-3.1-70b-versatile"
    ] as RemoteModelConfig;
    expect(cfg.providerInstanceId).toBe("groq");
    expect(store.getProviderSettings("openai-compatible", "groq")).toEqual({
      apiKey: "gsk",
      baseURL: "https://api.groq.com/openai/v1",
    });
  });

  it("is idempotent: re-importing refreshes labels, keeps existing status", () => {
    const { manager, store } = makeManager();

    manager.importDiscoveredModels(
      "anthropic",
      null,
      [{ id: "claude-sonnet-4-20250514", label: "Sonnet 4" }],
      { apiKey: "sk-ant" },
    );

    // Simulate activation
    const key = "anthropic/claude-sonnet-4-20250514";
    store.setStatus(key, "ready");

    const addedKeys = manager.importDiscoveredModels(
      "anthropic",
      null,
      [
        {
          id: "claude-sonnet-4-20250514",
          label: "Claude Sonnet 4 (refreshed)",
        },
      ],
      { apiKey: "sk-ant" },
    );

    expect(addedKeys).toEqual([]);
    const cfg = store.catalog[key] as RemoteModelConfig;
    expect(cfg.label).toBe("Claude Sonnet 4 (refreshed)");
    // Status preserved, not reset to not-downloaded
    expect(store.getState(key)?.status).toBe("ready");
  });
});
