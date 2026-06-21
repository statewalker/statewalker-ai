import type { ProviderV3 } from "@ai-sdk/provider";
import { createProviderRegistry, type ProviderRegistryProvider } from "ai";
import type { AiConfig } from "./ai-config.js";
import { MODEL_REFERENCE_SEPARATOR } from "./model-reference.js";

/** The subset of {@link AiConfig} the registry needs (eases stubbing in tests). */
export type AiConfigRegistrySource = Pick<AiConfig, "listConnections" | "getProvider" | "onUpdate">;

/**
 * A synchronous, self-refreshing provider registry over AiConfig connections.
 * Resolves a model-reference URI (`connectionId:modelId`) to a runtime model and
 * structurally matches consumers expecting `{ languageModel, textEmbeddingModel }`
 * (e.g. wiki's `LlmProvider`). Held by reference, so connection/key edits take
 * effect without the consumer re-registering. See `docs/adr/0001-model-reference-uri.md`.
 */
export interface LiveProviderRegistry {
  languageModel(reference: string): ReturnType<ProviderRegistryProvider["languageModel"]>;
  /** Named `textEmbeddingModel` to match consumers' `LlmProvider`; resolves the
   * registry's `embeddingModel`. */
  textEmbeddingModel(reference: string): ReturnType<ProviderRegistryProvider["embeddingModel"]>;
  /** Stop refreshing on AiConfig updates. */
  dispose(): void;
}

/** Build a one-shot registry from the current connections (skipping any that fail to build). */
async function buildRegistry(source: AiConfigRegistrySource): Promise<ProviderRegistryProvider> {
  const providers: Record<string, ProviderV3> = {};
  for (const c of source.listConnections()) {
    try {
      providers[c.id] = await source.getProvider(c.id);
    } catch (err) {
      console.warn(`[ai-config] skipping connection "${c.id}" in provider registry:`, err);
    }
  }
  // Default separator is ":", matching the model-reference URI.
  return createProviderRegistry(providers, { separator: MODEL_REFERENCE_SEPARATOR });
}

/**
 * Resolve the initial registry, then rebuild it on every `AiConfig.onUpdate`.
 * The returned object's methods always delegate to the latest build.
 */
export async function createLiveProviderRegistry(
  source: AiConfigRegistrySource,
): Promise<LiveProviderRegistry> {
  let registry = await buildRegistry(source);
  const unsubscribe = source.onUpdate(() => {
    void buildRegistry(source).then((next) => {
      registry = next;
    });
  });
  // The SDK registry types its id as `${provider}:${model}`; our reference URIs are
  // exactly that shape (validated at config-write time), so the cast is sound.
  return {
    languageModel: (reference) => registry.languageModel(reference as `${string}:${string}`),
    textEmbeddingModel: (reference) => registry.embeddingModel(reference as `${string}:${string}`),
    dispose: unsubscribe,
  };
}
