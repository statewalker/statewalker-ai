import type { ModelConfig } from "@statewalker/ai-provider";
import { Intents } from "@statewalker/shared-intents";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { Layout } from "@statewalker/workbench-views";
import { getWorkspace, type Workspace } from "@statewalker/workspace-api";
import { describe, expect, it } from "vitest";
import { runConfigureProvider, runListProviders } from "../../src/api/intents.js";
import { ModelManager } from "../../src/composition/adapters.js";
import initAiProviderCore from "../../src/index.js";
import type { AiConfigView } from "../../src/views/ai-config.view.js";

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
  it("populates the view's model list from runListModels on startup", async () => {
    const { view } = await setup();
    await new Promise((r) => setTimeout(r, 20));
    expect(view.modelList.rows.length).toBe(1);
    expect(view.modelList.rows[0]?.catalogKey).toBe("tjs#smol");
  });

  it("refreshes the provider list when configure-provider broadcasts", async () => {
    const { intents, view } = await setup();
    await new Promise((r) => setTimeout(r, 10));
    expect(view.providerList.rows.length).toBe(0);

    await runConfigureProvider(intents, {
      providerId: "anthropic",
      settings: { providerName: "anthropic", label: "Anthropic", apiKey: "sk" },
    }).promise;
    // Subsequent reload is async — wait a tick.
    await new Promise((r) => setTimeout(r, 10));

    expect(view.providerList.rows.length).toBe(1);
    expect(view.providerList.rows[0]?.providerId).toBe("anthropic");
  });

  it("dispatches runConfigureProvider when the add-remote-provider form submits", async () => {
    const { intents, view } = await setup();
    await new Promise((r) => setTimeout(r, 10));

    view.addRemoteProvider.providerNameField.selectedKey = "anthropic";
    view.addRemoteProvider.labelField.value = "My Anthropic";
    view.addRemoteProvider.apiKeyField.value = "sk-test";
    view.addRemoteProvider.submitAction.submit();

    await new Promise((r) => setTimeout(r, 10));

    const result = await runListProviders(intents, undefined).promise;
    expect(result).toHaveLength(1);
    expect(result[0]?.label).toBe("My Anthropic");
  });

  it("dispatches runRemoveProvider when providerList.removeAction submits with a row", async () => {
    const { intents, view } = await setup();
    await runConfigureProvider(intents, {
      providerId: "openai",
      settings: { providerName: "openai", label: "OpenAI", apiKey: "sk" },
    }).promise;
    await new Promise((r) => setTimeout(r, 10));

    const row = view.providerList.rows[0];
    expect(row).toBeDefined();
    if (!row) return;
    view.providerList.removeAction.submit(row);
    await new Promise((r) => setTimeout(r, 10));

    const after = await runListProviders(intents, undefined).promise;
    expect(after).toEqual([]);
  });

  it("toggles to the add-remote-provider form when empty.addRemoteProviderAction fires", async () => {
    const { view } = await setup();
    await new Promise((r) => setTimeout(r, 10));
    view.empty.addRemoteProviderAction.submit();
    expect(view.children).toContain(view.addRemoteProvider);
  });
});
