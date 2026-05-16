import { createStateStore } from "@json-render/core";
import { emptyProvidersConfig, Providers, type ProvidersConfig } from "@statewalker/ai-providers";
import { describe, expect, it } from "vitest";
import { bindPersistent } from "./state-bridge.js";

/**
 * Minimal fake of `LocalModels` matching the shape `bindPersistent`
 * reads (extends `BaseClass` semantics: `onUpdate` + `notify`-like
 * trigger).
 */
class FakeLocalModels {
  private listeners = new Set<() => void>();
  list(): readonly { modelId: string }[] {
    return [];
  }
  status(_: string): string {
    return "not-downloaded";
  }
  onUpdate(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  notify(): void {
    for (const cb of this.listeners) cb();
  }
}

describe("bindPersistent", () => {
  it("seeds /persistent/* paths on bind", () => {
    const store = createStateStore({
      persistent: {},
      ui: {},
    });
    const providers = new Providers();
    providers._setConfig({
      ...emptyProvidersConfig,
      connections: [{ id: "openai", type: "openai", name: "OpenAI", apiKey: "sk" }],
      starred: [{ connectionId: "openai", modelId: "gpt-4o" }],
    });
    const localModels = new FakeLocalModels();
    const dispose = bindPersistent(store, providers, localModels as never);
    const connections = store.get("/persistent/connections") as ProvidersConfig["connections"];
    expect(connections).toHaveLength(1);
    expect(connections[0]?.id).toBe("openai");
    const starred = store.get("/persistent/starred") as ProvidersConfig["starred"];
    expect(starred).toEqual([{ connectionId: "openai", modelId: "gpt-4o" }]);
    dispose();
  });

  it("propagates Providers.onUpdate notifications to /persistent/*", () => {
    const store = createStateStore({ persistent: {}, ui: {} });
    const providers = new Providers();
    const localModels = new FakeLocalModels();
    const dispose = bindPersistent(store, providers, localModels as never);
    // External update on the adapter.
    providers._setConfig({
      ...emptyProvidersConfig,
      connections: [{ id: "anthropic", type: "anthropic", name: "Anthropic", apiKey: "sk" }],
    });
    const connections = store.get("/persistent/connections") as ProvidersConfig["connections"];
    expect(connections).toHaveLength(1);
    expect(connections[0]?.type).toBe("anthropic");
    dispose();
  });

  it("releases subscriptions on dispose", () => {
    const store = createStateStore({ persistent: {}, ui: {} });
    const providers = new Providers();
    const localModels = new FakeLocalModels();
    const dispose = bindPersistent(store, providers, localModels as never);
    dispose();
    // After dispose, external updates should NOT flow into the store.
    providers._setConfig({
      ...emptyProvidersConfig,
      connections: [{ id: "openai", type: "openai", name: "OpenAI", apiKey: "sk" }],
    });
    const connections = store.get("/persistent/connections") as ProvidersConfig["connections"];
    expect(connections).toEqual([]);
  });
});
