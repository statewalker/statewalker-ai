import type { LanguageModelV3 } from "@ai-sdk/provider";
import type {
  ActivationProgress,
  LocalModelConfig,
  ModelManager,
} from "@statewalker/ai-provider";
import type { FilesApi } from "@statewalker/webrun-files";
import { resolveMlcFiles, verifyMlcWeights } from "./mlc-resolver.js";
import { registerWebLLMUrlMapping } from "./sw-bridge.js";
import { WebLLMLanguageModel } from "./webllm-language-model.js";
import { getWebLLMModule, type MLCEngine } from "./webllm-loader.js";

const MLC_BASE_URL_PREFIX = "https://huggingface.co/";

function modelUrlPrefix(modelId: string): string {
  if (modelId.startsWith("http://") || modelId.startsWith("https://")) {
    return modelId.endsWith("/") ? modelId : `${modelId}/`;
  }
  return `${MLC_BASE_URL_PREFIX}${modelId}/resolve/main/`;
}

function isEmbeddingModel(config: LocalModelConfig): boolean {
  // WebLLM embedding models have "embed" in the family or modelId.
  return (
    config.family.toLowerCase().includes("embed") ||
    config.modelId.toLowerCase().includes("embed")
  );
}

/**
 * Register WebLLM as the `"webllm"` engine on the given `ModelManager`.
 * Installs the factory, an MLC-aware file resolver, and a weight verifier
 * that checks for `mlc-chat-config.json`, `ndarray-cache.json`, and at
 * least one `params_shard_*.bin` file.
 *
 * Requires `@mlc-ai/web-llm` to be installed at activation time (not at
 * import time — this function is safe to call in any environment).
 */
export function registerWebLLMProvider(manager: ModelManager): void {
  manager.registerLocalFactory("webllm", {
    fileResolver: resolveMlcFiles,
    verifier: verifyMlcWeights,
    factory: async (
      modelId: string,
      config: LocalModelConfig,
      _files: FilesApi,
      onProgress: (progress: ActivationProgress) => void,
      signal?: AbortSignal,
    ): Promise<LanguageModelV3> => {
      if (!config.mlcModelLib) {
        throw new Error(
          `WebLLM model "${modelId}" is missing required \`mlcModelLib\` URL in its catalog entry.`,
        );
      }

      const webllm = await getWebLLMModule();
      signal?.throwIfAborted();

      onProgress({
        modelKey: modelId,
        phase: "loading",
        progress: 0,
        message: "Creating WebLLM engine…",
      });

      const engine: MLCEngine = new webllm.MLCEngine({
        appConfig: {
          model_list: [
            {
              model: modelId.startsWith("http")
                ? modelId
                : `${MLC_BASE_URL_PREFIX}${modelId}`,
              model_id: modelId,
              model_lib: config.mlcModelLib,
              vram_required_MB: config.mlcVramRequiredMB,
              model_type: isEmbeddingModel(config) ? 2 /* embedding */ : 0,
              overrides: config.mlcContextWindowSize
                ? { context_window_size: config.mlcContextWindowSize }
                : undefined,
            },
          ],
          cacheBackend: "cache",
        },
        initProgressCallback: (report: { progress: number; text: string }) => {
          onProgress({
            modelKey: modelId,
            phase: report.progress < 1 ? "loading" : "warming",
            progress: report.progress,
            message: report.text,
          });
        },
      });

      signal?.throwIfAborted();
      await engine.reload(modelId);

      // Register a bridge mapping so subsequent reloads served from
      // FilesApi (the first reload above streams through the SW too when
      // active — in that case it's a network miss that populates the
      // FilesApi cache at the same time).
      await registerWebLLMUrlMapping(
        modelUrlPrefix(modelId),
        `/models/webllm/${modelId}/`,
      ).catch(() => {
        /* ignored — SW not available is not fatal */
      });

      onProgress({
        modelKey: modelId,
        phase: "ready",
        progress: 1,
        message: `${config.label} ready`,
      });

      if (isEmbeddingModel(config)) {
        // Embedding models don't implement LanguageModelV3. The factory
        // contract is `LanguageModelV3`, so callers who want embeddings
        // should instantiate `WebLLMEmbeddingModel` directly from their
        // own `MLCEngine`. Fail loudly here to avoid silently returning
        // the wrong shape through `ModelManager.activate`.
        throw new Error(
          `Model "${modelId}" looks like an embedding model; activate it via WebLLMEmbeddingModel directly rather than through ModelManager (which only tracks LanguageModelV3 instances).`,
        );
      }
      return new WebLLMLanguageModel(engine, modelId);
    },
  });
}
