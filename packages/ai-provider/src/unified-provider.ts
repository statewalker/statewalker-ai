import type { EmbeddingModelV3, ImageModelV3, LanguageModelV3, ProviderV3 } from "@ai-sdk/provider";
import { NoSuchModelError } from "@ai-sdk/provider";
import type { ModelStateStore } from "./model-state-store.js";

/**
 * A ProviderV3 implementation that delegates to ModelStateStore.
 * Models must be activated via ModelManager.activate() before use.
 */
export class UnifiedProvider implements ProviderV3 {
  readonly specificationVersion = "v3" as const;

  constructor(private readonly store: ModelStateStore) {}

  languageModel(modelId: string): LanguageModelV3 {
    return this.store.getLanguageModel(modelId);
  }

  embeddingModel(modelId: string): EmbeddingModelV3 {
    throw new NoSuchModelError({ modelId, modelType: "embeddingModel" });
  }

  imageModel(modelId: string): ImageModelV3 {
    throw new NoSuchModelError({ modelId, modelType: "imageModel" });
  }
}
