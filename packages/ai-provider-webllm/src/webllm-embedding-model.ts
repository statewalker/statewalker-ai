import type {
  EmbeddingModelV3,
  EmbeddingModelV3CallOptions,
  EmbeddingModelV3Result,
} from "@ai-sdk/provider";
import type { MLCEngine } from "./webllm-loader.js";

// biome-ignore lint/suspicious/noExplicitAny: WebLLM embedding response shape varies
type EmbeddingResponse = any;

/**
 * EmbeddingModelV3 implementation wrapping a WebLLM MLCEngine loaded with
 * an embedding model (e.g. `snowflake-arctic-embed-m-q0f32-MLC-b4`).
 */
export class WebLLMEmbeddingModel implements EmbeddingModelV3 {
  readonly specificationVersion = "v3" as const;
  readonly provider = "webllm";
  readonly modelId: string;
  readonly maxEmbeddingsPerCall: number;
  readonly supportsParallelCalls = false;

  constructor(
    private readonly engine: MLCEngine,
    modelId: string,
    options?: { maxEmbeddingsPerCall?: number },
  ) {
    this.modelId = modelId;
    this.maxEmbeddingsPerCall = options?.maxEmbeddingsPerCall ?? 4;
  }

  async doEmbed(
    options: EmbeddingModelV3CallOptions,
  ): Promise<EmbeddingModelV3Result> {
    const response: EmbeddingResponse = await this.engine.embeddings.create({
      input: options.values,
      model: this.modelId,
    });
    const embeddings: number[][] = (response.data ?? []).map(
      (entry: { embedding: number[] }) => entry.embedding,
    );
    return {
      embeddings,
      warnings: [],
      ...(response.usage?.total_tokens != null
        ? { usage: { tokens: response.usage.total_tokens } }
        : {}),
    };
  }
}
