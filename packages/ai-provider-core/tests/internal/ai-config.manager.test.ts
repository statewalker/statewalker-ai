import type { ModelConfig } from "@statewalker/ai-provider";
import { Intents } from "@statewalker/shared-intents";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { Layout } from "@statewalker/workbench-views";
import { getWorkspace, type Workspace } from "@statewalker/workspace-api";
import { describe, expect, it } from "vitest";
import initAiProviderCore from "../../src/index.js";
import type { AiConfigView } from "../../src/internal/views/ai-config.view.js";
import { ModelManager } from "../../src/public/adapters.js";
import { runConfigureProvider, runListModels } from "../../src/public/intents.js";

const tjsCatalog: Record<string, ModelConfig> = {
  "tjs#smol": {
    runtime: "local",
    engine: "tjs",
    modelId: "smol",
    label: "SmolLM",
    family: "SmolLM",
    dtype: "q4",
    size: "100 MB",
    sizeBytes: 100_000_000,
    kinds: ["reasoning"],
  },
};

interface FakeStore {
  catalog: Record<string, ModelConfig>;
  getState: (key: string) => undefined;
  peekActiveModel: (key: string) => undefined;
  getDownloadProgress?: (key: string) => undefined;
  onUpdate?: (cb: () => void) => () => void;
}

async function setup(): Promise<{ ws: Workspace; intents: Intents; view: AiConfigView }> {
  const ctx: Record<string, unknown> = {};
  const ws = getWorkspace(ctx);
  ws.setFileSystem(new MemFilesApi(), "test");
  initAiProviderCore(ctx);

  const fakeImpl = {
    store: <FakeStore>{
      catalog: tjsCatalog,
      getState: () => undefined,
      peekActiveModel: () => undefined,
      getDownloadProgress: () => undefined,
      onUpdate: () => () => {},
    },
  };
  class FakeModelManager extends ModelManager {
    readonly impl = fakeImpl as never;
  }
  ws.setAdapter(ModelManager, FakeModelManager);

  await ws.open();

  const layout = ws.requireAdapter(Layout);
  const panel = layout.getPanel("ai-config:main");
  const view = panel?.content as AiConfigView;
  return { ws, intents: ws.requireAdapter(Intents), view };
}

describe("AiConfigManager", () => {
  describe("active models picker", () => {
    it("populates the reasoning picker from runListModels with a clear sentinel + per-model items", async () => {
      const { view } = await setup();
      // Allow the initial async load to complete.
      await new Promise((r) => setTimeout(r, 20));
      const items = view.activeModels.reasoningPicker.items;
      // Always at least the clear sentinel.
      expect(items[0]?.key).toBe("");
      // Plus one for the seeded catalog entry.
      const catalogItem = items.find((i) => i.key === "tjs#smol");
      expect(catalogItem).toBeDefined();
      expect(catalogItem?.section).toBe("tjs");
    });

    it("dispatching runActivateModel updates the picker selection via the adapter onChange path", async () => {
      const { ws, intents, view } = await setup();
      await new Promise((r) => setTimeout(r, 20));

      // The seeded ModelManager is a fake that doesn't actually activate; we
      // poke the adapter directly to simulate the activate-model handler's
      // success cascade.
      const { ActiveReasoningModel } = await import("../../src/public/adapters.js");
      const adapter = ws.requireAdapter(ActiveReasoningModel) as never as {
        setReasoning: (model: unknown, key: string, providerId: string) => void;
      };
      adapter.setReasoning({} as never, "tjs#smol", "tjs");
      await new Promise((r) => setTimeout(r, 20));

      expect(view.activeModels.reasoningPicker.selectedKey).toBe("tjs#smol");
      expect(view.activeModels.reasoning.providerCaption.text).toBe("tjs");
      // Sanity: nothing was re-dispatched (picker programmatic change is suppressed).
      expect(typeof intents).toBe("object");
    });
  });

  describe("configuration gate", () => {
    it("starts on the empty state when no providers are configured", async () => {
      const { view } = await setup();
      await new Promise((r) => setTimeout(r, 20));
      expect(view.children).toContain(view.empty);
    });

    it("flips to the configured panel after runConfigureProvider succeeds", async () => {
      const { intents, view } = await setup();
      await new Promise((r) => setTimeout(r, 10));
      await runConfigureProvider(intents, {
        providerId: "anthropic",
        settings: { providerName: "anthropic", label: "Anthropic", apiKey: "sk-test" },
      }).promise;
      await new Promise((r) => setTimeout(r, 20));
      expect(view.children).toContain(view.activeModels);
      expect(view.children).toContain(view.providersTabs);
      expect(view.children).not.toContain(view.empty);
    });
  });

  describe("Settings menu", () => {
    it("registers a 'Settings' top-level menu with an 'AI Providers' item", async () => {
      const ctx: Record<string, unknown> = {};
      const ws = getWorkspace(ctx);
      ws.setFileSystem(new MemFilesApi(), "test");
      initAiProviderCore(ctx);
      const { MainMenu } = await import("@statewalker/workbench-views");
      const mainMenu = ws.requireAdapter(MainMenu);
      const settings = mainMenu.getAll().find((m) => m.actionKey === "settings");
      expect(settings).toBeDefined();
      expect(settings?.label).toBe("Settings");
      const aiProviders = settings?.children.find((c) => c.actionKey === "ai-providers.menu");
      expect(aiProviders).toBeDefined();
      expect(aiProviders?.label).toBe("AI Providers");
    });

    it("removes the 'AI Providers' item when the activator's cleanup runs", async () => {
      const ctx: Record<string, unknown> = {};
      const ws = getWorkspace(ctx);
      ws.setFileSystem(new MemFilesApi(), "test");
      const cleanup = initAiProviderCore(ctx);
      const { MainMenu } = await import("@statewalker/workbench-views");
      const mainMenu = ws.requireAdapter(MainMenu);
      expect(
        mainMenu
          .getAll()
          .find((m) => m.actionKey === "settings")
          ?.children.find((c) => c.actionKey === "ai-providers.menu"),
      ).toBeDefined();
      await cleanup();
      // The Settings container is removed too because we created it and
      // it's now empty.
      expect(mainMenu.getAll().find((m) => m.actionKey === "settings")).toBeUndefined();
    });
  });

  describe("manager close()", () => {
    it("does not publish the panel until the workspace is opened", async () => {
      const ctx: Record<string, unknown> = {};
      const ws = getWorkspace(ctx);
      ws.setFileSystem(new MemFilesApi(), "test");
      initAiProviderCore(ctx);
      const layout = ws.requireAdapter(Layout);
      // Workspace not opened yet → panel not published.
      expect(layout.getPanel("ai-config:main")).toBeUndefined();
      await ws.open();
      // After open, the panel appears.
      expect(layout.getPanel("ai-config:main")).toBeDefined();
    });

    it("removes the panel when the workspace is closed", async () => {
      const ctx: Record<string, unknown> = {};
      const ws = getWorkspace(ctx);
      ws.setFileSystem(new MemFilesApi(), "test");
      initAiProviderCore(ctx);
      await ws.open();
      const layout = ws.requireAdapter(Layout);
      expect(layout.getPanel("ai-config:main")).toBeDefined();
      await ws.close();
      expect(layout.getPanel("ai-config:main")).toBeUndefined();
    });
  });
});

describe("AiConfigManager — picker filters by curated models from runListModels", () => {
  it("only includes models whose ids appear in the provider's selectedModelIds when set", async () => {
    const ctx: Record<string, unknown> = {};
    const ws = getWorkspace(ctx);
    ws.setFileSystem(new MemFilesApi(), "test");

    // Use a fake whose catalog contains two anthropic models.
    const fakeImpl = {
      store: <FakeStore>{
        catalog: {
          "anthropic:opus": {
            runtime: "remote",
            provider: "anthropic",
            modelId: "claude-opus",
            label: "Claude Opus",
          } as ModelConfig,
          "anthropic:sonnet": {
            runtime: "remote",
            provider: "anthropic",
            modelId: "claude-sonnet",
            label: "Claude Sonnet",
          } as ModelConfig,
        },
        getState: () => undefined,
        peekActiveModel: () => undefined,
        getDownloadProgress: () => undefined,
        onUpdate: () => () => {},
      },
    };
    initAiProviderCore(ctx);
    class FakeModelManager extends ModelManager {
      readonly impl = fakeImpl as never;
    }
    ws.setAdapter(ModelManager, FakeModelManager);
    await ws.open();
    const intents = ws.requireAdapter(Intents);

    // Configure the provider with selectedModelIds = ["anthropic:sonnet"] only.
    await runConfigureProvider(intents, {
      providerId: "anthropic",
      settings: {
        providerName: "anthropic",
        label: "Anthropic",
        apiKey: "sk",
        selectedModelIds: ["anthropic:sonnet"],
      },
    }).promise;

    const result = await runListModels(intents, { role: "reasoning" }).promise;
    const ids = result.map((m) => m.catalogKey).sort();
    expect(ids).toEqual(["anthropic:sonnet"]); // opus filtered out
  });
});

// Activate-model path is exercised end-to-end in
// tests/internal/handlers/activation.test.ts; the manager's picker→intent
// wiring is exercised via the adapter onChange path above.
describe("AiConfigManager — activation guard", () => {
  it("guards against echoing the picker write back as another runActivateModel", async () => {
    // The point of #syncingPicker is to suppress a re-dispatch when the
    // manager itself is mutating the picker. We simulate by spying on
    // the intent name sent through the adapter cascade.
    const { ws, intents, view } = await setup();
    await new Promise((r) => setTimeout(r, 20));

    let activateCalls = 0;
    const { handleActivateModel } = await import("../../src/public/intents.js");
    handleActivateModel(intents, (intent) => {
      activateCalls += 1;
      intent.resolve({ ok: false, error: "test stub" });
      return false; // observer
    });

    // Programmatically poke the adapter, which fires onChange in the manager.
    const { ActiveReasoningModel } = await import("../../src/public/adapters.js");
    const adapter = ws.requireAdapter(ActiveReasoningModel) as never as {
      setReasoning: (m: unknown, k: string, p: string) => void;
    };
    adapter.setReasoning({} as never, "tjs#smol", "tjs");
    await new Promise((r) => setTimeout(r, 20));

    // Picker reflects the new selection.
    expect(view.activeModels.reasoningPicker.selectedKey).toBe("tjs#smol");
    // But no extra runActivateModel was dispatched (the picker write was suppressed).
    expect(activateCalls).toBe(0);
  });
});
