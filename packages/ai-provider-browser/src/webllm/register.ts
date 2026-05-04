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
     * Probe FilesApi for the SW-bridged weight files. We don't rely on
     * WebLLM's `hasModelInCache` because (a) it defaults to
     * `prebuiltAppConfig` when called without an `appConfig` and our
     * custom catalog entries are absent from the prebuilt list, so the
     * lookup throws; and (b) the SW write-through populates FilesApi
     * directly — making the on-disk files the single source of truth.
     *
     * Logs every probe so users can correlate "Not downloaded" status
     * after a reload with the actual on-disk state.
     */
    engineHasWeights: async (config: LocalModelConfig, files): Promise<boolean> => {
      if (!files) {
        console.warn("[webllm] engineHasWeights: no FilesApi configured");
        return false;
      }
      const dir = `${basePath}/${config.modelId}`;
      try {
        const found: { name: string; kind: string }[] = [];
        let hasConfig = false;
        let hasCache = false;
        let hasShard = false;
        for await (const entry of files.list(dir, { recursive: true })) {
          found.push({ name: entry.name, kind: entry.kind });
          if (entry.kind !== "file") continue;
          if (entry.name === "mlc-chat-config.json") hasConfig = true;
          else if (entry.name === "ndarray-cache.json") hasCache = true;
          else if (entry.name.startsWith("params_shard_") && entry.name.endsWith(".bin")) {
            hasShard = true;
          }
        }
        const present = hasConfig && hasCache && hasShard;
        console.log("[webllm] engineHasWeights", {
          dir,
          modelId: config.modelId,
          present,
          hasConfig,
          hasCache,
          hasShard,
          fileCount: found.length,
        });
        return present;
      } catch (error) {
        console.warn("[webllm] engineHasWeights probe failed", dir, error);
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
      await registerWebLLMUrlMapping(modelUrlPrefix(modelId), `${basePath}/${modelId}/`).catch(
        () => {
          /* ignored — SW not available is not fatal */
        },
      );

      signal?.throwIfAborted();
      console.log(`[webllm] engine.reload(${modelId}) starting`);
      try {
        await engine.reload(modelId);
        console.log(`[webllm] engine.reload(${modelId}) returned`);
      } catch (e) {
        console.error(`[webllm] engine.reload(${modelId}) threw`, e);
        throw e;
      }

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
