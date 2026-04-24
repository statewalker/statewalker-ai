import { ModelManager, ModelStateStore, type RemoteModelConfig } from "@statewalker/ai-provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddRemoteProviderFormVM } from "../../src/domain/add-remote-provider.form.js";

function makeManager(): ModelManager {
  const store = new ModelStateStore({});
  return new ModelManager({ store });
}

describe("AddRemoteProviderFormVM integration with ModelManager", () => {
  afterEach(() => vi.restoreAllMocks());

  it("success path: submitAdd → discovered → Save imports catalog entries", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      async json() {
        return {
          data: [
            { id: "claude-sonnet-4-20250514", display_name: "Sonnet 4" },
            { id: "claude-haiku-4-5-20251001" },
          ],
        };
      },
      async text() {
        return "";
      },
    } as unknown as Response);

    const manager = makeManager();
    const vm = new AddRemoteProviderFormVM(manager.testConnection.bind(manager));
    vm.setProviderType("anthropic");
    vm.setApiKey("sk-ant");

    const ok = await vm.submitAdd();
    expect(ok).toBe(true);
    expect(vm.step).toBe("discovered");

    // Simulate the user clicking Save in the controller
    const selected = vm.getSelectedDiscovered();
    manager.importDiscoveredModels("anthropic", null, selected, vm.buildSettings());

    const imported = Object.keys(manager.store.catalog).sort();
    expect(imported).toEqual([
      "anthropic/claude-haiku-4-5-20251001",
      "anthropic/claude-sonnet-4-20250514",
    ]);
    const cfg = manager.store.catalog["anthropic/claude-sonnet-4-20250514"] as RemoteModelConfig;
    expect(cfg.label).toBe("Sonnet 4");
    expect(cfg.kinds).toEqual(["reasoning"]);
    expect(manager.store.getProviderSettings("anthropic")).toEqual({
      apiKey: "sk-ant",
    });
  });

  it("failure path leaves no state behind", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 401,
      async json() {
        return {};
      },
      async text() {
        return "unauthorized";
      },
    } as unknown as Response);

    const manager = makeManager();
    const vm = new AddRemoteProviderFormVM(manager.testConnection.bind(manager));
    vm.setProviderType("openai");
    vm.setApiKey("bad");

    const ok = await vm.submitAdd();
    expect(ok).toBe(false);
    expect(vm.connectionError).toMatch(/HTTP 401/);
    expect(vm.step).toBe("credentials");
    // Nothing imported
    expect(Object.keys(manager.store.catalog)).toEqual([]);
    expect(manager.store.getProviderSettings("openai")).toBeUndefined();
  });
});
