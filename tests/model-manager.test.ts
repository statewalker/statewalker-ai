import { describe, expect, it, vi } from "vitest";
import { ModelManager } from "../src/model-manager.js";
import { ModelStateStore } from "../src/model-state-store.js";
import type {
  ActivationProgress,
  LocalModelConfig,
  ModelConfig,
} from "../src/types.js";

const REMOTE_MODEL: ModelConfig = {
  runtime: "remote",
  provider: "anthropic",
  modelId: "claude-test",
  label: "Test Claude",
};

const LOCAL_MODEL: LocalModelConfig = {
  runtime: "local",
  modelId: "test/local-model",
  label: "Test Local",
  family: "Test",
  dtype: "q4f16",
  size: "100 MB",
  sizeBytes: 100_000_000,
};

function createManager(catalog: Record<string, ModelConfig>) {
  const store = new ModelStateStore(catalog);
  const manager = new ModelManager({ store });
  return { store, manager };
}

async function collectProgress(
  gen: AsyncGenerator<ActivationProgress>,
): Promise<ActivationProgress[]> {
  const events: ActivationProgress[] = [];
  for await (const p of gen) events.push(p);
  return events;
}

describe("ModelManager", () => {
  describe("store.getStates / store.getState", () => {
    it("initializes states for all catalog entries", () => {
      const { store } = createManager({
        "remote:test": REMOTE_MODEL,
        "local:test": LOCAL_MODEL,
      });
      const states = store.getStates();
      expect(states.size).toBe(2);
      expect(states.get("remote:test")?.status).toBe("not-downloaded");
      expect(states.get("local:test")?.status).toBe("not-downloaded");
    });

    it("returns undefined for unknown model", () => {
      const { store } = createManager({});
      expect(store.getState("nonexistent")).toBeUndefined();
    });
  });

  describe("activate remote model", () => {
    it("yields error when no API key provided", async () => {
      const { manager } = createManager({ "remote:test": REMOTE_MODEL });
      const events = await collectProgress(manager.activate("remote:test"));
      expect(events.at(-1)?.phase).toBe("error");
      expect(events.at(-1)?.message).toContain("API key");
    });
  });

  describe("activate unknown model", () => {
    it("yields error for unknown model key", async () => {
      const { manager } = createManager({});
      const events = await collectProgress(manager.activate("unknown"));
      expect(events).toHaveLength(1);
      expect(events[0]?.phase).toBe("error");
      expect(events[0]?.message).toContain("Unknown model");
    });
  });

  describe("activate local model without factory", () => {
    it("yields error when no local factory registered", async () => {
      const { manager } = createManager({ "local:test": LOCAL_MODEL });
      const events = await collectProgress(manager.activate("local:test"));
      expect(events.at(-1)?.phase).toBe("error");
      expect(events.at(-1)?.message).toContain("ai-provider-local");
    });
  });

  describe("activate local model without files", () => {
    it("yields error when no FilesApi configured", async () => {
      const { manager } = createManager({ "local:test": LOCAL_MODEL });
      manager.registerLocalFactory(vi.fn());
      const events = await collectProgress(manager.activate("local:test"));
      expect(events.at(-1)?.phase).toBe("error");
      expect(events.at(-1)?.message).toContain("FilesApi");
    });
  });

  describe("store.getLanguageModel", () => {
    it("throws when model is not ready", () => {
      const { store } = createManager({ "remote:test": REMOTE_MODEL });
      expect(() => store.getLanguageModel("remote:test")).toThrow(/not ready/);
    });
  });

  describe("deactivate", () => {
    it("sets local model status back to downloaded", () => {
      const { store, manager } = createManager({ "local:test": LOCAL_MODEL });
      // Manually set to ready for this test
      store.setStatus("local:test", "ready");

      manager.deactivate("local:test");
      expect(store.getState("local:test")?.status).toBe("downloaded");
    });
  });

  describe("cancel", () => {
    it("does not throw when cancelling non-active model", () => {
      const { manager } = createManager({});
      expect(() => manager.cancel("nonexistent")).not.toThrow();
    });
  });
});
