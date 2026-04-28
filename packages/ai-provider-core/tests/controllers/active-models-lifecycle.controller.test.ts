import {
  type LocalModelFactory,
  ModelManager,
  ModelStateStore,
  type RemoteModelConfig,
} from "@statewalker/ai-provider";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createActiveModelsLifecycleController,
  setActiveModelsFilesApi,
} from "../../src/composition/active-models-lifecycle.controller.js";
import { setModelListView } from "../../src/composition/model-settings.controller.js";
import { setModelManager } from "../../src/core/legacy-adapters.js";
import { ModelListView } from "../../src/core/model-list.view.js";
import { ProviderSettingsStore } from "../../src/core/provider-settings.store.js";

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timeout");
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

function makeCtx(catalog: Record<string, RemoteModelConfig> = {}): {
  ctx: Record<string, unknown>;
  manager: ModelManager;
  files: MemFilesApi;
  listView: ModelListView;
} {
  const files = new MemFilesApi();
  const store = new ModelStateStore(catalog);
  const manager = new ModelManager({ store, files });
  const ctx: Record<string, unknown> = {};
  setModelManager(ctx, manager);
  setActiveModelsFilesApi(ctx, files);
  const listView = new ModelListView();
  setModelListView(ctx, listView);
  return { ctx, manager, files, listView };
}

async function seedProvidersJson(files: MemFilesApi, content: unknown): Promise<void> {
  await files.mkdir("/.settings");
  await files.write("/.settings/providers.json", [
    new TextEncoder().encode(JSON.stringify(content, null, 2)),
  ]);
}

describe("active-models-lifecycle.controller", () => {
  afterEach(() => vi.restoreAllMocks());

  it("hydrates provider settings from providers.json on startup", async () => {
    const { ctx, manager, files } = makeCtx({
      "anthropic/claude": {
        runtime: "remote",
        provider: "anthropic",
        modelId: "claude",
        label: "Claude",
      },
    });
    await seedProvidersJson(files, {
      anthropic: { apiKey: "sk-hydrated" },
    });

    const cleanup = createActiveModelsLifecycleController(ctx);
    await waitFor(() => !!manager.store.getProviderSettings("anthropic"));
    expect(manager.store.getProviderSettings("anthropic")?.apiKey).toBe("sk-hydrated");
    await cleanup();
  });

  it("re-activates a local reasoning model whose weights are downloaded", async () => {
    const { ctx, manager, files, listView } = makeCtx();
    // Seed a local model into the catalog with "downloaded" status
    manager.store.addCatalogEntry("local:tiny", {
      runtime: "local",
      engine: "tjs",
      modelId: "tiny-model",
      label: "Tiny",
      family: "Test",
      dtype: "q4f16",
      size: "1 MB",
      sizeBytes: 1_000_000,
    });
    manager.store.setStatus("local:tiny", "downloaded");

    // Register a minimal factory that yields a fake LanguageModelV3.
    const factory: LocalModelFactory = async () =>
      ({ modelId: "tiny-model", provider: "test" }) as never;
    manager.registerLocalFactory("tjs", factory);

    await seedProvidersJson(files, {
      activeModels: { reasoning: ["local:tiny"], embedding: [] },
    });

    const cleanup = createActiveModelsLifecycleController(ctx);
    await waitFor(() => manager.store.getState("local:tiny")?.status === "ready");
    expect(listView.hasActiveReasoning).toBe(true);
    await cleanup();
  });

  it("leaves entries in activeModels when re-activation fails (no creds)", async () => {
    const { ctx, manager, files } = makeCtx({
      "anthropic/claude": {
        runtime: "remote",
        provider: "anthropic",
        modelId: "claude",
        label: "Claude",
      },
    });
    await seedProvidersJson(files, {
      activeModels: { reasoning: ["anthropic/claude"], embedding: [] },
    });

    const cleanup = createActiveModelsLifecycleController(ctx);
    // Wait for startup re-activation pass to finish (either skip or fail).
    await new Promise((r) => setTimeout(r, 30));

    const after = await new ProviderSettingsStore(files).load();
    // Entry preserved on disk for retry once credentials are added.
    expect(after.activeModels?.reasoning).toContain("anthropic/claude");
    // Not ready — no credentials were provided.
    expect(manager.store.getState("anthropic/claude")?.status).not.toBe("ready");
    await cleanup();
  });

  it("writes activeModels to disk when a model becomes ready", async () => {
    const { ctx, manager, files } = makeCtx({
      "anthropic/claude": {
        runtime: "remote",
        provider: "anthropic",
        modelId: "claude",
        label: "Claude",
        kinds: ["reasoning"],
      },
    });
    await seedProvidersJson(files, { anthropic: { apiKey: "sk" } });

    const cleanup = createActiveModelsLifecycleController(ctx);
    // Wait for startup to complete and the write-through listener to attach
    await new Promise((r) => setTimeout(r, 30));

    // Simulate a successful activation
    manager.store.setStatus("anthropic/claude", "ready");
    manager.store.setActiveModelKey("anthropic/claude", "Claude");

    // Debounce is 200 ms; wait for flush
    await new Promise((r) => setTimeout(r, 300));

    const persisted = await new ProviderSettingsStore(files).load();
    expect(persisted.activeModels?.reasoning).toEqual(["anthropic/claude"]);
    await cleanup();
  });
});
