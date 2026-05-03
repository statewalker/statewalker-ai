import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { ModelConfig } from "@statewalker/ai-agent/models";
import { Intents } from "@statewalker/shared-intents";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { getWorkspace, type Workspace } from "@statewalker/workspace-api";
import { describe, expect, it } from "vitest";
import initAiProviderCore from "../../../src/index.js";
import {
  ActiveEmbeddingModel,
  ActiveReasoningModel,
  ModelManager,
} from "../../../src/public/adapters.js";
import {
  handleActiveModelChanged,
  runActivateModel,
  runDeactivateModel,
  runGetActiveModel,
} from "../../../src/public/intents.js";

interface FakeModelManagerImpl {
  store: {
    catalog: Record<string, ModelConfig>;
    getState: (key: string) => undefined;
    peekActiveModel: (key: string) => LanguageModelV3 | undefined;
  };
  activations: Map<string, LanguageModelV3>;
  activate: (
    key: string,
    options?: { signal?: AbortSignal },
  ) => AsyncGenerator<{
    modelKey: string;
    phase: "ready" | "error";
    message: string;
    error?: Error;
  }>;
  deactivate: (key: string) => void;
  cancel: (key: string) => void;
}

function fakeManager(catalog: Record<string, ModelConfig>): FakeModelManagerImpl {
  const activations = new Map<string, LanguageModelV3>();
  const fake: FakeModelManagerImpl = {
    store: {
      catalog,
      getState: () => undefined,
      peekActiveModel: (key) => activations.get(key),
    },
    activations,
    async *activate(key) {
      const config = catalog[key];
      if (!config) {
        yield { modelKey: key, phase: "error", message: `Unknown ${key}` };
        return;
      }
      const model = { __mockedModelFor: key } as unknown as LanguageModelV3;
      activations.set(key, model);
      yield { modelKey: key, phase: "ready", message: "ready" };
    },
    deactivate(key) {
      activations.delete(key);
    },
    cancel(_key) {
      // no-op
    },
  };
  return fake;
}

const sonnet: ModelConfig = {
  runtime: "remote",
  provider: "anthropic",
  modelId: "claude-sonnet-4",
  label: "Claude Sonnet 4",
  kinds: ["reasoning"],
};

const embedding: ModelConfig = {
  runtime: "remote",
  provider: "openai",
  modelId: "text-embedding-3",
  label: "OpenAI Text Embedding 3",
  kinds: ["embedding"],
};

async function setup(catalog: Record<string, ModelConfig>): Promise<{
  ws: Workspace;
  intents: Intents;
  manager: FakeModelManagerImpl;
}> {
  const ctx: Record<string, unknown> = {};
  const ws = getWorkspace(ctx);
  ws.setFileSystem(new MemFilesApi(), "test");
  initAiProviderCore(ctx);

  const manager = fakeManager(catalog);
  class FakeModelManagerToken extends ModelManager {
    readonly impl = manager as never;
  }
  ws.setAdapter(ModelManager, FakeModelManagerToken);

  await ws.open();
  return { ws, intents: ws.requireAdapter(Intents), manager };
}

describe("ai-provider per-role activation", () => {
  describe("activate-model", () => {
    it("updates ActiveReasoningModel and broadcasts active-model-changed", async () => {
      const { ws, intents } = await setup({ "anthropic#sonnet": sonnet });

      const broadcasts: Array<{ role: string; catalogKey: string | undefined }> = [];
      handleActiveModelChanged(intents, (intent) => {
        broadcasts.push(intent.payload);
        intent.resolve();
        return false;
      });

      const result = await runActivateModel(intents, {
        catalogKey: "anthropic#sonnet",
        role: "reasoning",
      }).promise;

      expect(result.ok).toBe(true);
      const active = ws.requireAdapter(ActiveReasoningModel);
      expect(active.catalogKey).toBe("anthropic#sonnet");
      expect(active.providerId).toBe("anthropic");
      expect(active.model).toBeDefined();
      expect(broadcasts).toContainEqual({
        role: "reasoning",
        catalogKey: "anthropic#sonnet",
      });
    });

    it("returns ok=false when the catalog has no such key", async () => {
      const { intents } = await setup({});
      const result = await runActivateModel(intents, {
        catalogKey: "missing",
        role: "reasoning",
      }).promise;
      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("activating reasoning does NOT touch embedding (role isolation)", async () => {
      const { ws, intents } = await setup({
        "anthropic#sonnet": sonnet,
        "openai#emb": embedding,
      });

      await runActivateModel(intents, {
        catalogKey: "anthropic#sonnet",
        role: "reasoning",
      }).promise;
      await runActivateModel(intents, {
        catalogKey: "openai#emb",
        role: "embedding",
      }).promise;

      const r = ws.requireAdapter(ActiveReasoningModel);
      const e = ws.requireAdapter(ActiveEmbeddingModel);
      expect(r.catalogKey).toBe("anthropic#sonnet");
      expect(e.catalogKey).toBe("openai#emb");
    });
  });

  describe("get-active-model", () => {
    it("returns the live LanguageModelV3 + catalogKey for the requested role", async () => {
      const { intents } = await setup({ "anthropic#sonnet": sonnet });
      await runActivateModel(intents, {
        catalogKey: "anthropic#sonnet",
        role: "reasoning",
      }).promise;

      const reasoning = await runGetActiveModel(intents, { role: "reasoning" }).promise;
      expect(reasoning).toBeDefined();
      expect(reasoning?.catalogKey).toBe("anthropic#sonnet");
      expect(reasoning?.model).toBeDefined();

      const embedding = await runGetActiveModel(intents, { role: "embedding" }).promise;
      expect(embedding).toBeUndefined();
    });
  });

  describe("deactivate-model", () => {
    it("clears the per-role adapter and broadcasts active-model-changed", async () => {
      const { ws, intents } = await setup({ "anthropic#sonnet": sonnet });
      await runActivateModel(intents, {
        catalogKey: "anthropic#sonnet",
        role: "reasoning",
      }).promise;
      expect(ws.requireAdapter(ActiveReasoningModel).catalogKey).toBe("anthropic#sonnet");

      const broadcasts: Array<{ role: string; catalogKey: string | undefined }> = [];
      handleActiveModelChanged(intents, (intent) => {
        broadcasts.push(intent.payload);
        intent.resolve();
        return false;
      });

      await runDeactivateModel(intents, { role: "reasoning" }).promise;

      expect(ws.requireAdapter(ActiveReasoningModel).catalogKey).toBeUndefined();
      expect(ws.requireAdapter(ActiveReasoningModel).model).toBeUndefined();
      expect(broadcasts).toContainEqual({
        role: "reasoning",
        catalogKey: undefined,
      });
    });
  });
});
