import type { LanguageModelV3 } from "@ai-sdk/provider";
import type {
  ActivationProgress,
  LocalModelConfig,
  ModelManager,
} from "@statewalker/ai-agent/models";
import type { FilesApi } from "@statewalker/webrun-files";
import { LocalLanguageModel } from "./language-model.js";
import { createPipeline } from "./loader.js";

/**
 * Register the local model provider with a ModelManager.
 * This enables activation of `runtime: "local"` models via transformers.js.
 */
export function registerLocalProvider(manager: ModelManager): void {
  manager.registerLocalFactory("tjs", {
    factory: async (
      modelId: string,
      config: LocalModelConfig,
      files: FilesApi,
      _onProgress: (progress: ActivationProgress) => void,
      _signal?: AbortSignal,
    ): Promise<LanguageModelV3> => {
      const { pipeline, tjs } = await createPipeline(modelId, config.dtype, files, "/models/tjs");
      return new LocalLanguageModel(modelId, pipeline, tjs, config.maxNewTokens);
    },
  });
}
