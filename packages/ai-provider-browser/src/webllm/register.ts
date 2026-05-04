import type { LanguageModelV3 } from "@ai-sdk/provider";
import type {
  ActivationProgress,
  LocalModelConfig,
  ModelManager,
} from "@statewalker/ai-agent/models";
import type { FilesApi } from "@statewalker/webrun-files";
import { WebLLMLanguageModel } from "./language-model.js";
import { getWebLLMModule, type MLCEngine } from "./loader.js";
import { resolveMlcFiles, verifyMlcWeights } from "./mlc-resolver.js";
import { registerWebLLMUrlMapping } from "./sw-bridge.js";

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
    config.family.toLowerCase().includes("embed") || config.modelId.toLowerCase().includes("embed")
  );
}

export interface RegisterWebLLMProviderOptions {
  /**
   * Base path under the workspace `FilesApi` where weight files are
   * persisted by the Service Worker bridge. Defaults to
   * `/models/webllm`. The bridge writes to `${basePath}/${modelId}/...`
   * for each registered URL mapping. If you want weights to live under
   * a system folder (e.g. `/.settings/models/webllm`), set this to that
   * folder — it must already be writable on the active `FilesApi`.
   */
  basePath?: string;
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
export function registerWebLLMProvider(
  manager: ModelManager,
  options: RegisterWebLLMProviderOptions = {},
): void {
  const basePath = (options.basePath ?? "/models/webllm").replace(/\/+$/, "");
  manager.registerLocalFactory("webllm", {
    fileResolver: resolveMlcFiles,
    verifier: verifyMlcWeights,
    /**
     * WebLLM keeps weights in IndexedDB by default (the SW bridge to
     * FilesApi is opt-in). Probe its cache via `hasModelInCache(...)` so
     * `refreshLocalStatuses()` can surface previously-downloaded models
     * after a reload.
     */
    engineHasWeights: async (config: LocalModelConfig): Promise<boolean> => {
      try {
        const webllm = await getWebLLMModule();
        if (typeof webllm.hasModelInCache !== "function") return false;
        return await webllm.hasModelInCache(config.modelId);
      } catch {
        return false;
      }
    },
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
              model: modelId.startsWith("http") ? modelId : `${MLC_BASE_URL_PREFIX}${modelId}`,
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

      // Register the URL mapping BEFORE reload so the SW intercepts the
      // first set of fetches and tees the bytes to FilesApi as they
      // stream past. Without this, the first activation downloads
      // straight to WebLLM's IDB cache and weights never appear on disk.
      await registerWebLLMUrlMapping(
        modelUrlPrefix(modelId),
        `${basePath}/${modelId}/`,
      ).catch(() => {
        /* ignored — SW not available is not fatal */
      });

      signal?.throwIfAborted();
      await engine.reload(modelId);

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
