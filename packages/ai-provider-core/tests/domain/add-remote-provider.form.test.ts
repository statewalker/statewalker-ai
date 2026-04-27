import type {
  DiscoveredModel,
  ProviderName,
  RemoteProviderSettings,
} from "@statewalker/ai-provider";
import { describe, expect, it } from "vitest";
import { AddRemoteProviderFormVM } from "../../src/core/add-remote-provider.form.js";

function makeVM(
  impl: (provider: ProviderName, settings: RemoteProviderSettings) => Promise<DiscoveredModel[]>,
): AddRemoteProviderFormVM {
  return new AddRemoteProviderFormVM(impl);
}

describe("AddRemoteProviderFormVM", () => {
  it("starts on step 'credentials' with idle status", () => {
    const vm = makeVM(async () => []);
    expect(vm.step).toBe("credentials");
    expect(vm.connectionStatus).toBe("idle");
    expect(vm.canAdd).toBe(false); // no credentials yet
  });

  it("canAdd requires apiKey for canonical providers", () => {
    const vm = makeVM(async () => []);
    vm.setProviderType("anthropic");
    expect(vm.canAdd).toBe(false);
    vm.setApiKey("sk-ant");
    expect(vm.canAdd).toBe(true);
  });

  it("canAdd for openai-compatible requires baseURL and displayName", () => {
    const vm = makeVM(async () => []);
    vm.setProviderType("openai-compatible");
    expect(vm.canAdd).toBe(false);
    vm.setBaseURL("http://localhost:1234/v1");
    expect(vm.canAdd).toBe(false);
    vm.setDisplayName("LM Studio");
    expect(vm.canAdd).toBe(true);
  });

  it("submitAdd success transitions credentials → discovered", async () => {
    const vm = makeVM(async () => [
      { id: "m1", label: "Model 1" },
      { id: "m2", label: "Model 2" },
    ]);
    vm.setProviderType("anthropic");
    vm.setApiKey("sk-ant");

    const statuses: string[] = [];
    vm.onUpdate(() => statuses.push(vm.connectionStatus));

    const ok = await vm.submitAdd();
    expect(ok).toBe(true);
    expect(vm.step).toBe("discovered");
    expect(vm.discoveredModels).toHaveLength(2);
    // All pre-selected by default
    expect(vm.discoveredModels.every((m) => m.selected)).toBe(true);
    expect(vm.canSave).toBe(true);
    expect(statuses).toContain("connecting");
  });

  it("submitAdd failure stays on credentials with error", async () => {
    const vm = makeVM(async () => {
      throw new Error("Unauthorized");
    });
    vm.setProviderType("openai");
    vm.setApiKey("bad");

    const ok = await vm.submitAdd();
    expect(ok).toBe(false);
    expect(vm.step).toBe("credentials");
    expect(vm.connectionStatus).toBe("error");
    expect(vm.connectionError).toBe("Unauthorized");
    expect(vm.canSave).toBe(false);
    expect(vm.discoveredModels).toEqual([]);
  });

  it("editing a field after an error clears the error", async () => {
    const vm = makeVM(async () => {
      throw new Error("oops");
    });
    vm.setProviderType("anthropic");
    vm.setApiKey("bad");
    await vm.submitAdd();
    expect(vm.connectionError).toBe("oops");
    vm.setApiKey("better");
    expect(vm.connectionError).toBe("");
  });

  it("toggleDiscoveredModel and setAllSelected update canSave", async () => {
    const vm = makeVM(async () => [
      { id: "m1", label: "M1" },
      { id: "m2", label: "M2" },
    ]);
    vm.setProviderType("anthropic");
    vm.setApiKey("k");
    await vm.submitAdd();
    expect(vm.canSave).toBe(true);

    vm.setAllSelected(false);
    expect(vm.canSave).toBe(false);
    vm.toggleDiscoveredModel("m1");
    expect(vm.canSave).toBe(true);

    const selected = vm.getSelectedDiscovered();
    expect(selected).toEqual([{ id: "m1", label: "M1" }]);
  });

  it("changing providerType to canonical clears openai-compatible fields", () => {
    const vm = makeVM(async () => []);
    vm.setProviderType("openai-compatible");
    vm.setBaseURL("http://x");
    vm.setDisplayName("X");
    vm.setProviderType("anthropic");
    expect(vm.baseURL).toBe("");
    expect(vm.displayName).toBe("");
  });

  it("reset returns to credentials step with empty discovered", async () => {
    const vm = makeVM(async () => [{ id: "m1", label: "M1" }]);
    vm.setProviderType("anthropic");
    vm.setApiKey("k");
    await vm.submitAdd();
    expect(vm.step).toBe("discovered");
    vm.reset();
    expect(vm.step).toBe("credentials");
    expect(vm.discoveredModels).toEqual([]);
    expect(vm.connectionStatus).toBe("idle");
  });
});
