import type { LanguageModelV3 } from "@ai-sdk/provider";
import { type TransformersJSModelSettings, transformersJS } from "@browser-ai/transformers-js";
import type {
  ActivationProgress,
  LocalModelConfig,
  ModelManager,
} from "@statewalker/ai-agent/models";
import type { FilesApi } from "@statewalker/webrun-files";

type TjsDtype = NonNullable<TransformersJSModelSettings["dtype"]>;

export interface RegisterLocalProviderOptions {
  /**
   * Base path under the workspace `FilesApi` where weight files are
   * persisted by the Service Worker bridge. Defaults to `/models/tjs`.
   * Apps wiring a system folder (e.g. chat-mini's `/.settings`) should
   * point this at `/.settings/models/tjs` so weights live alongside
   * other workspace artifacts instead of at the workspace root.
   */
  basePath?: string;
}

/**
 * Register the transformers.js local-model provider with a ModelManager.
 * Activates `runtime: "local", engine: "tjs"` catalog entries through
 * `@browser-ai/transformers-js` (the official Vercel AI SDK adapter for
 * transformers.js) and probes `${basePath}/${modelId}` for cached weight
 * files so previously-downloaded models surface as `downloaded` after a
 * reload.
 */
export function registerLocalProvider(
  manager: ModelManager,
  options: RegisterLocalProviderOptions = {},
): void {
  const basePath = (options.basePath ?? "/models/tjs").replace(/\/+$/, "");
  manager.registerLocalFactory("tjs", {
    /**
     * Probe FilesApi for ONNX files written by the SW bridge during
     * the first activation. We don't rely on
     * `LocalModelStorage.hasWeights` because that requires a metadata
     * file that's only written when bytes go through
     * `LocalModelStorage.download` — but for browser-side activation
     * the bytes flow through transformers.js + the SW write-through
     * directly, never via `download`. The on-disk `config.json` plus
     * at least one `.onnx` weight file is the right "downloaded"
     * signal.
     */
    engineHasWeights: async (
      config: LocalModelConfig,
      files: FilesApi | undefined,
    ): Promise<boolean> => {
      if (!files) {
        console.warn("[tjs] engineHasWeights: no FilesApi configured");
        return false;
      }
      const dir = `${basePath}/${config.modelId}`;
      try {
        let hasConfig = false;
        let hasOnnx = false;
        let fileCount = 0;
        for await (const entry of files.list(dir, { recursive: true })) {
          if (entry.kind !== "file") continue;
          fileCount += 1;
          if (entry.name === "config.json") hasConfig = true;
          else if (entry.name.endsWith(".onnx") || entry.name.includes(".onnx_data")) {
            hasOnnx = true;
          }
        }
        const present = hasConfig && hasOnnx;
        console.log("[tjs] engineHasWeights", {
          dir,
          modelId: config.modelId,
          present,
          hasConfig,
          hasOnnx,
          fileCount,
        });
        return present;
      } catch (error) {
        console.warn("[tjs] engineHasWeights probe failed", dir, error);
        return false;
      }
    },
    factory: async (
      modelId: string,
      config: LocalModelConfig,
      _files: FilesApi,
      onProgress: (progress: ActivationProgress) => void,
      _signal?: AbortSignal,
    ): Promise<LanguageModelV3> => {
      const dtype = config.dtype as TjsDtype;
      const errors: Array<{ device: string; error: unknown }> = [];
      // WASM-only by default. WebGPU on the current onnxruntime-web build
      // reliably throws `safeint.h Integer overflow` for these models —
      // sometimes during the adapter's 1-token warmup, sometimes only on
      // the first real generation (warmup is too short to surface the
      // overflow). Once the model is committed to WebGPU we can't catch
      // the late failure at the factory boundary, so we never pick WebGPU.
      // Re-add `"webgpu"` to the head of this array if the upstream EP is
      // fixed and worth the speed-up.
      for (const device of ["wasm"] as const) {
        const model = transformersJS(modelId, { device, dtype });
        try {
          await model.createSessionWithProgress((progress) => {
            onProgress({
              modelKey: modelId,
              phase: "downloading",
              progress,
              message: `Loading ${modelId} on ${device}: ${Math.round(progress * 100)}%`,
            });
          });
          return model;
        } catch (error) {
          console.warn(`[tjs] init failed on ${device} for ${modelId}`, error);
          errors.push({ device, error });
        }
      }
      const detail = errors
        .map(
          ({ device, error }) =>
            `${device}: ${error instanceof Error ? error.message : String(error)}`,
        )
        .join("; ");
      throw new Error(`Could not initialize ${modelId} on any device — ${detail}`);
    },
  });
}
