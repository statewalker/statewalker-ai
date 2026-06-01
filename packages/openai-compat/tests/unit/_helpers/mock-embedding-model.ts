import type { EmbeddingModelV3, EmbeddingModelV3CallOptions } from "@ai-sdk/provider";

export interface MockEmbeddingModelInit {
  modelId?: string;
  provider?: string;
  embeddings?: number[][];
  tokens?: number;
  throwOnEmbed?: Error;
}

export const mockEmbeddingModel = (
  init: MockEmbeddingModelInit = {},
): EmbeddingModelV3 & {
  recordedCalls: EmbeddingModelV3CallOptions[];
} => {
  const recordedCalls: EmbeddingModelV3CallOptions[] = [];
  return {
    specificationVersion: "v3",
    provider: init.provider ?? "mock",
    modelId: init.modelId ?? "mock-embedding",
    maxEmbeddingsPerCall: 100,
    supportsParallelCalls: true,
    recordedCalls,
    async doEmbed(options) {
      recordedCalls.push(options);
      if (init.throwOnEmbed) throw init.throwOnEmbed;
      const fallback = options.values.map((_, i) => [i, i, i]);
      return {
        embeddings: init.embeddings ?? fallback,
        usage: { tokens: init.tokens ?? options.values.length },
        warnings: [],
      };
    },
  };
};
