import { Intents } from "@statewalker/shared-intents";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { getWorkspace, type Workspace } from "@statewalker/workspace-api";
import { beforeEach, describe, expect, it } from "vitest";
import initAiProviderCore from "../../../src/index.js";
import type {
  ActiveEmbeddingModelImpl,
  ActiveReasoningModelImpl,
} from "../../../src/internal/adapters.impl.js";
import { ActiveEmbeddingModel, ActiveReasoningModel } from "../../../src/public/adapters.js";
import {
  handleActiveModelChanged,
  handleProvidersChanged,
  runConfigureProvider,
  runListProviders,
  runRemoveProvider,
} from "../../../src/public/intents.js";
import type { ProviderDescriptor } from "../../../src/public/types.js";

async function setup(): Promise<{ ws: Workspace; intents: Intents }> {
  const ctx: Record<string, unknown> = {};
  const ws = getWorkspace(ctx);
  ws.setFileSystem(new MemFilesApi(), "test");
  initAiProviderCore(ctx);
  await ws.open();
  return { ws, intents: ws.requireAdapter(Intents) };
}

describe("ai-provider provider intents", () => {
  beforeEach(() => {
    // each test makes a fresh ctx, so workspaces don't bleed across
  });

  describe("list-providers", () => {
    it("returns an empty array when no providers configured", async () => {
      const { intents } = await setup();
      const result = await runListProviders(intents, undefined).promise;
      expect(result).toEqual([]);
    });

    it("returns descriptors for configured providers", async () => {
      const { intents } = await setup();
      await runConfigureProvider(intents, {
        providerId: "anthropic",
        settings: { apiKey: "sk-test", providerName: "anthropic", label: "Anthropic" },
      }).promise;

      const result = await runListProviders(intents, undefined).promise;
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        providerId: "anthropic",
        providerName: "anthropic",
        label: "Anthropic",
        runtime: "remote",
        hasCredentials: true,
      });
    });

    it("filters by runtime", async () => {
      const { intents } = await setup();
      await runConfigureProvider(intents, {
        providerId: "anthropic",
        settings: { apiKey: "sk", providerName: "anthropic", label: "Anthropic" },
      }).promise;

      const remote = await runListProviders(intents, { runtime: "remote" }).promise;
      expect(remote).toHaveLength(1);
      const local = await runListProviders(intents, { runtime: "local" }).promise;
      expect(local).toHaveLength(0);
    });
  });

  describe("configure-provider", () => {
    it("persists settings, returns ok, and broadcasts providers-changed", async () => {
      const { intents } = await setup();
      const broadcasts: ProviderDescriptor[][] = [];
      handleProvidersChanged(intents, (intent) => {
        broadcasts.push(intent.payload);
        intent.resolve();
        return false; // observer, not a claim
      });

      const result = await runConfigureProvider(intents, {
        providerId: "anthropic",
        settings: { apiKey: "sk-test", providerName: "anthropic", label: "Anthropic" },
      }).promise;

      expect(result.ok).toBe(true);
      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0]).toHaveLength(1);
      expect(broadcasts[0]?.[0]?.providerId).toBe("anthropic");
    });

    it("returns ok=false when settings are invalid", async () => {
      const { intents } = await setup();
      const result = await runConfigureProvider(intents, {
        providerId: "anthropic",
        // missing required fields — providerName / label
        // biome-ignore lint/suspicious/noExplicitAny: deliberate invalid payload
        settings: { apiKey: "sk-test" } as any,
      }).promise;
      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("remove-provider", () => {
    it("removes the provider and broadcasts providers-changed", async () => {
      const { intents } = await setup();
      await runConfigureProvider(intents, {
        providerId: "anthropic",
        settings: { apiKey: "sk", providerName: "anthropic", label: "Anthropic" },
      }).promise;

      const broadcasts: ProviderDescriptor[][] = [];
      handleProvidersChanged(intents, (intent) => {
        broadcasts.push(intent.payload);
        intent.resolve();
        return false;
      });

      await runRemoveProvider(intents, { providerId: "anthropic" }).promise;

      const result = await runListProviders(intents, undefined).promise;
      expect(result).toEqual([]);
      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0]).toEqual([]);
    });

    it("is a no-op when the provider does not exist", async () => {
      const { intents } = await setup();
      await runRemoveProvider(intents, { providerId: "nonexistent" }).promise;
      // No throw, no broadcast assertion needed — just the call resolves.
    });

    it("cascades to clear ActiveReasoningModel when its provider is removed", async () => {
      const { ws, intents } = await setup();
      await runConfigureProvider(intents, {
        providerId: "anthropic",
        settings: { apiKey: "sk", providerName: "anthropic", label: "Anthropic" },
      }).promise;

      // Simulate an active reasoning model belonging to "anthropic".
      const activeReasoning = ws.requireAdapter(ActiveReasoningModel) as ActiveReasoningModelImpl;
      const fakeModel = { tag: "fake-model" } as never;
      activeReasoning.setReasoning(fakeModel, "anthropic#claude-3.5", "anthropic");
      expect(activeReasoning.catalogKey).toBe("anthropic#claude-3.5");

      const activeChanges: Array<{ role: string; catalogKey: string | undefined }> = [];
      handleActiveModelChanged(intents, (intent) => {
        activeChanges.push(intent.payload);
        intent.resolve();
        return false;
      });

      await runRemoveProvider(intents, { providerId: "anthropic" }).promise;

      expect(activeReasoning.model).toBeUndefined();
      expect(activeReasoning.catalogKey).toBeUndefined();
      expect(activeReasoning.providerId).toBeUndefined();
      expect(activeChanges).toEqual([{ role: "reasoning", catalogKey: undefined }]);
    });

    it("does NOT clear ActiveEmbeddingModel when reasoning provider is removed (independent roles)", async () => {
      const { ws, intents } = await setup();
      await runConfigureProvider(intents, {
        providerId: "anthropic",
        settings: { apiKey: "sk", providerName: "anthropic", label: "Anthropic" },
      }).promise;
      await runConfigureProvider(intents, {
        providerId: "openai",
        settings: { apiKey: "sk", providerName: "openai", label: "OpenAI" },
      }).promise;

      const activeReasoning = ws.requireAdapter(ActiveReasoningModel) as ActiveReasoningModelImpl;
      const activeEmbedding = ws.requireAdapter(ActiveEmbeddingModel) as ActiveEmbeddingModelImpl;

      activeReasoning.setReasoning({ tag: "r" } as never, "anthropic#claude-3.5", "anthropic");
      activeEmbedding.setEmbedding({ tag: "e" } as never, "openai#text-embedding-3", "openai");

      await runRemoveProvider(intents, { providerId: "anthropic" }).promise;

      expect(activeReasoning.providerId).toBeUndefined();
      expect(activeEmbedding.providerId).toBe("openai");
      expect(activeEmbedding.catalogKey).toBe("openai#text-embedding-3");
    });
  });

  describe("configure-provider settings additive fields (selectedModelIds, enabled)", () => {
    it("persists selectedModelIds for remote providers", async () => {
      const { ws, intents } = await setup();
      await runConfigureProvider(intents, {
        providerId: "anthropic",
        settings: {
          providerName: "anthropic",
          label: "Anthropic",
          apiKey: "sk",
          selectedModelIds: ["anthropic:claude-opus", "anthropic:claude-sonnet"],
        },
      }).promise;

      const { ProviderSettingsStore } = await import("../../../src/public/adapters.js");
      const store = ws.requireAdapter(ProviderSettingsStore);
      const stored = (await store.get("anthropic")) as {
        selectedModelIds?: string[];
      };
      expect(stored.selectedModelIds).toEqual(["anthropic:claude-opus", "anthropic:claude-sonnet"]);
    });

    it("persists local-provider enabled flag under the local#${engineId} key prefix", async () => {
      const { ws, intents } = await setup();
      await runConfigureProvider(intents, {
        providerId: "webllm",
        settings: { providerName: "webllm", label: "webllm", enabled: false },
      }).promise;
      const { ProviderSettingsStore } = await import("../../../src/public/adapters.js");
      const store = ws.requireAdapter(ProviderSettingsStore);
      const stored = (await store.get("local#webllm")) as { enabled?: boolean };
      expect(stored.enabled).toBe(false);

      // The local provider does not surface in the remote-providers list.
      const list = await runListProviders(intents, { runtime: "remote" }).promise;
      expect(list.find((p: ProviderDescriptor) => p.providerId === "webllm")).toBeUndefined();
    });

    it("does NOT write the new fields when the payload omits them (backwards compat)", async () => {
      const { ws, intents } = await setup();
      await runConfigureProvider(intents, {
        providerId: "openai",
        settings: { providerName: "openai", label: "OpenAI", apiKey: "sk", baseURL: "https://x" },
      }).promise;
      const { ProviderSettingsStore } = await import("../../../src/public/adapters.js");
      const store = ws.requireAdapter(ProviderSettingsStore);
      const stored = (await store.get("openai")) as Record<string, unknown>;
      expect(stored.selectedModelIds).toBeUndefined();
      expect(stored.enabled).toBeUndefined();
      expect(stored.apiKey).toBe("sk");
      expect(stored.baseURL).toBe("https://x");
    });
  });
});
