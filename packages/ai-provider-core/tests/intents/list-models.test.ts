import type { ModelConfig, ModelState, ModelStatus } from "@statewalker/ai-provider";
import { Intents } from "@statewalker/shared-intents";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { getWorkspace, type Workspace } from "@statewalker/workspace-api";
import { describe, expect, it } from "vitest";
import { runListModels } from "../../src/api/intents.js";
import type {
  ActiveEmbeddingModelImpl,
  ActiveReasoningModelImpl,
} from "../../src/composition/adapters.impl.js";
import {
  ActiveEmbeddingModel,
  ActiveReasoningModel,
  ModelManager,
} from "../../src/composition/adapters.js";
import initAiProviderCore from "../../src/index.js";

type CatalogEntry = ModelConfig;

interface FakeStore {
  catalog: Record<string, CatalogEntry>;
  getState(key: string): ModelState | undefined;
}

function fakeStateFor(
  catalog: Record<string, CatalogEntry>,
  statuses: Record<string, ModelStatus>,
): FakeStore {
  return {
    catalog,
    getState(key) {
      const config = catalog[key];
      if (!config) return undefined;
      return { config, status: statuses[key] ?? ("ready" as ModelStatus) };
    },
  };
}

async function setup(
  catalog: Record<string, CatalogEntry>,
  statuses: Record<string, ModelStatus> = {},
): Promise<{ ws: Workspace; intents: Intents }> {
  const ctx: Record<string, unknown> = {};
  const ws = getWorkspace(ctx);
  ws.setFileSystem(new MemFilesApi(), "test");
  initAiProviderCore(ctx);

  const fakeImpl = { store: fakeStateFor(catalog, statuses) };
  class FakeModelManager extends ModelManager {
    readonly impl = fakeImpl as never;
  }
  ws.setAdapter(ModelManager, FakeModelManager);

  await ws.open();
  return { ws, intents: ws.requireAdapter(Intents) };
}

const remoteSonnet: ModelConfig = {
  runtime: "remote",
  provider: "anthropic",
  modelId: "claude-sonnet-4",
  label: "Claude Sonnet 4",
  kinds: ["reasoning"],
};

const remoteOpus: ModelConfig = {
  runtime: "remote",
  provider: "anthropic",
  modelId: "claude-opus-4",
  label: "Claude Opus 4",
};

const localSmollm: ModelConfig = {
  runtime: "local",
  engine: "tjs",
  modelId: "smollm-135m",
  label: "SmolLM 135M",
  family: "SmolLM",
  dtype: "q4",
  size: "100 MB",
  sizeBytes: 100_000_000,
  kinds: ["reasoning"],
};

const remoteEmbedding: ModelConfig = {
  runtime: "remote",
  provider: "openai",
  modelId: "text-embedding-3",
  label: "OpenAI Text Embedding 3",
  kinds: ["embedding"],
};

describe("ai-provider:list-models intent", () => {
  it("returns descriptors for every entry in the catalog when no filter", async () => {
    const { intents } = await setup({
      "anthropic#sonnet": remoteSonnet,
      "tjs#smollm": localSmollm,
    });
    const result = await runListModels(intents, undefined).promise;
    expect(result).toHaveLength(2);
    const keys = result.map((d) => d.catalogKey).sort();
    expect(keys).toEqual(["anthropic#sonnet", "tjs#smollm"]);
  });

  it("populates required descriptor fields", async () => {
    const { intents } = await setup({ "tjs#smollm": localSmollm });
    const [d] = await runListModels(intents, undefined).promise;
    expect(d).toMatchObject({
      catalogKey: "tjs#smollm",
      label: "SmolLM 135M",
      providerId: "tjs",
      runtime: "local",
      kinds: ["reasoning"],
      sizeBytes: 100_000_000,
      isActiveReasoning: false,
      isActiveEmbedding: false,
    });
    expect(d?.status).toBe("ready");
  });

  it("filters by runtime", async () => {
    const { intents } = await setup({
      "anthropic#sonnet": remoteSonnet,
      "tjs#smollm": localSmollm,
    });
    const remote = await runListModels(intents, { runtime: "remote" }).promise;
    expect(remote.map((d) => d.catalogKey)).toEqual(["anthropic#sonnet"]);
    const local = await runListModels(intents, { runtime: "local" }).promise;
    expect(local.map((d) => d.catalogKey)).toEqual(["tjs#smollm"]);
  });

  it("filters by role (intersects with descriptor.kinds)", async () => {
    const { intents } = await setup({
      "anthropic#sonnet": remoteSonnet,
      "openai#emb": remoteEmbedding,
    });
    const reasoning = await runListModels(intents, { role: "reasoning" }).promise;
    expect(reasoning.map((d) => d.catalogKey)).toEqual(["anthropic#sonnet"]);
    const embedding = await runListModels(intents, { role: "embedding" }).promise;
    expect(embedding.map((d) => d.catalogKey)).toEqual(["openai#emb"]);
  });

  it("filters by providerId", async () => {
    const { intents } = await setup({
      "anthropic#sonnet": remoteSonnet,
      "anthropic#opus": remoteOpus,
      "openai#emb": remoteEmbedding,
    });
    const onlyAnthropic = await runListModels(intents, { providerId: "anthropic" }).promise;
    expect(onlyAnthropic.map((d) => d.catalogKey).sort()).toEqual([
      "anthropic#opus",
      "anthropic#sonnet",
    ]);
  });

  it("filters by status", async () => {
    const { intents } = await setup(
      {
        "tjs#a": localSmollm,
        "tjs#b": { ...localSmollm, modelId: "other" },
      },
      { "tjs#a": "ready", "tjs#b": "not-downloaded" },
    );
    const ready = await runListModels(intents, { status: "ready" }).promise;
    expect(ready.map((d) => d.catalogKey)).toEqual(["tjs#a"]);
  });

  it("sets isActiveReasoning / isActiveEmbedding from the per-role adapters", async () => {
    const { ws, intents } = await setup({
      "anthropic#sonnet": remoteSonnet,
      "openai#emb": remoteEmbedding,
    });

    const activeReasoning = ws.requireAdapter(ActiveReasoningModel) as ActiveReasoningModelImpl;
    const activeEmbedding = ws.requireAdapter(ActiveEmbeddingModel) as ActiveEmbeddingModelImpl;
    activeReasoning.setReasoning({ tag: "r" } as never, "anthropic#sonnet", "anthropic");
    activeEmbedding.setEmbedding({ tag: "e" } as never, "openai#emb", "openai");

    const result = await runListModels(intents, undefined).promise;
    const sonnet = result.find((d) => d.catalogKey === "anthropic#sonnet");
    const emb = result.find((d) => d.catalogKey === "openai#emb");
    expect(sonnet?.isActiveReasoning).toBe(true);
    expect(sonnet?.isActiveEmbedding).toBe(false);
    expect(emb?.isActiveEmbedding).toBe(true);
    expect(emb?.isActiveReasoning).toBe(false);
  });
});
