import type { FilesApi } from "@statewalker/webrun-files";

// biome-ignore lint/suspicious/noExplicitAny: transformers.js has no stable type exports
type TjsModule = any;
// biome-ignore lint/suspicious/noExplicitAny: pipeline type varies
type TjsPipeline = any;

let _tjs: TjsModule | null = null;

/** Lazy-load the @huggingface/transformers module. */
export async function getTransformersModule(): Promise<TjsModule> {
  if (_tjs) return _tjs;
  try {
    _tjs = await import("@huggingface/transformers");
  } catch {
    throw new Error(
      "Local model support requires @huggingface/transformers. " +
        "Install it with: npm install @huggingface/transformers",
    );
  }
  _tjs.env.allowLocalModels = false;
  _tjs.env.useBrowserCache = false;
  return _tjs;
}

/**
 * Create a transformers.js text-generation pipeline for the given model.
 * Reads model files from FilesApi storage.
 * Tries WebGPU first, falls back to WASM.
 */
export async function createPipeline(
  modelId: string,
  dtype: string,
  _files: FilesApi,
  _basePath: string,
): Promise<{ pipeline: TjsPipeline; tjs: TjsModule }> {
  const tjs = await getTransformersModule();

  for (const device of ["webgpu", "wasm"] as const) {
    try {
      const pipeline = await tjs.pipeline("text-generation", modelId, {
        dtype,
        device,
      });
      return { pipeline, tjs };
    } catch (e) {
      if (device === "wasm") {
        throw new Error(
          `Could not load ${modelId} on any device: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      // WebGPU failed, try WASM next
    }
  }

  throw new Error(`Could not load ${modelId} on any device`);
}
