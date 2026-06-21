import type { ProviderV3 } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { type AiConfigRegistrySource, createLiveProviderRegistry } from "./provider-registry.js";
import type { Connection } from "./types.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A fake provider whose model objects record which connection + model they came from. */
function fakeProvider(connectionId: string): ProviderV3 {
  return {
    languageModel: (modelId: string) => ({ kind: "lm", connectionId, modelId }),
    embeddingModel: (modelId: string) => ({ kind: "em", connectionId, modelId }),
  } as unknown as ProviderV3;
}

function conn(id: string): Connection {
  return { id, type: "openai", name: id, starredModelIds: [] };
}

function source(opts: {
  connections: Connection[];
  provider: (id: string) => ProviderV3;
}): AiConfigRegistrySource & { fire: () => void } {
  let cb: (() => void) | undefined;
  return {
    listConnections: () => opts.connections,
    getProvider: async (id) => opts.provider(id),
    onUpdate: (fn) => {
      cb = fn;
      return () => {
        cb = undefined;
      };
    },
    fire: () => cb?.(),
  };
}

describe("createLiveProviderRegistry", () => {
  it("resolves a language model URI to the right connection's provider", async () => {
    const reg = await createLiveProviderRegistry(
      source({ connections: [conn("openai")], provider: fakeProvider }),
    );
    expect(reg.languageModel("openai:gpt-4.1")).toMatchObject({
      kind: "lm",
      connectionId: "openai",
      modelId: "gpt-4.1",
    });
  });

  it("resolves an embedding model URI", async () => {
    const reg = await createLiveProviderRegistry(
      source({ connections: [conn("openai")], provider: fakeProvider }),
    );
    expect(reg.textEmbeddingModel("openai:text-embedding-3-large")).toMatchObject({
      kind: "em",
      connectionId: "openai",
      modelId: "text-embedding-3-large",
    });
  });

  it("rebuilds on update so a swapped provider is used without re-registration", async () => {
    let providerFor = fakeProvider;
    const src = source({ connections: [conn("openai")], provider: (id) => providerFor(id) });
    const reg = await createLiveProviderRegistry(src);

    // Swap the backing provider (simulating a key/connection change) and fire onUpdate.
    providerFor = (id) =>
      ({
        languageModel: (modelId: string) => ({ kind: "lm", connectionId: `${id}!`, modelId }),
        embeddingModel: () => ({}),
      }) as unknown as ProviderV3;
    src.fire();
    await tick();

    expect(reg.languageModel("openai:gpt-4.1")).toMatchObject({ connectionId: "openai!" });
  });
});
