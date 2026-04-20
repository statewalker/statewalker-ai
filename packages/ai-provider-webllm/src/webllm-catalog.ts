import type { LocalModelConfig } from "@statewalker/ai-provider";

/**
 * URLs are the WebLLM-compatible paths (HuggingFace `mlc-ai/*` repos for
 * weights, `binary-mlc-llm-libs` for the .wasm libraries). Kept in sync
 * with `prebuiltAppConfig.model_list` in the reference WebLLM package.
 *
 * Sizes are approximate and used only for progress UX while downloading
 * (actual bytes come from ndarray-cache.json).
 */
const LIB_PREFIX =
  "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_80/";

function ctx4k1k(filename: string): string {
  return `${LIB_PREFIX}${filename}-ctx4k_cs1k-webgpu.wasm`;
}

/**
 * Default catalog of WebLLM models. Merge into the app catalog with
 * `mergeCatalogs(createDefaultCatalog(), webllmCatalog, ...)`.
 */
export const webllmCatalog: Record<string, LocalModelConfig> = {
  "webllm:llama-3.2-1b": {
    runtime: "local",
    engine: "webllm",
    modelId: "mlc-ai/Llama-3.2-1B-Instruct-q4f16_1-MLC",
    label: "Llama 3.2-1B (WebGPU)",
    family: "Llama 3.2",
    dtype: "q4f16_1",
    size: "880 MB",
    sizeBytes: 922_746_880,
    mlcModelLib: ctx4k1k("Llama-3.2-1B-Instruct-q4f16_1"),
    mlcContextWindowSize: 4096,
    mlcVramRequiredMB: 879,
  },
  "webllm:llama-3.2-3b": {
    runtime: "local",
    engine: "webllm",
    modelId: "mlc-ai/Llama-3.2-3B-Instruct-q4f16_1-MLC",
    label: "Llama 3.2-3B (WebGPU)",
    family: "Llama 3.2",
    dtype: "q4f16_1",
    size: "2.2 GB",
    sizeBytes: 2_375_000_000,
    mlcModelLib: ctx4k1k("Llama-3.2-3B-Instruct-q4f16_1"),
    mlcContextWindowSize: 4096,
    mlcVramRequiredMB: 2264,
  },
  "webllm:gemma-2-2b": {
    runtime: "local",
    engine: "webllm",
    modelId: "mlc-ai/gemma-2-2b-it-q4f16_1-MLC",
    label: "Gemma 2-2B IT (WebGPU)",
    family: "Gemma 2",
    dtype: "q4f16_1",
    size: "1.9 GB",
    sizeBytes: 2_040_109_465,
    mlcModelLib: ctx4k1k("gemma-2-2b-it-q4f16_1"),
    mlcContextWindowSize: 4096,
    mlcVramRequiredMB: 1895,
  },
  "webllm:phi-3.5-mini": {
    runtime: "local",
    engine: "webllm",
    modelId: "mlc-ai/Phi-3.5-mini-instruct-q4f16_1-MLC",
    label: "Phi 3.5-mini (WebGPU)",
    family: "Phi",
    dtype: "q4f16_1",
    size: "2.2 GB",
    sizeBytes: 2_300_000_000,
    mlcModelLib: ctx4k1k("Phi-3.5-mini-instruct-q4f16_1"),
    mlcContextWindowSize: 4096,
    mlcVramRequiredMB: 2200,
  },
  "webllm:snowflake-arctic-embed-m": {
    runtime: "local",
    engine: "webllm",
    modelId: "mlc-ai/snowflake-arctic-embed-m-q0f32-MLC",
    label: "Snowflake Arctic Embed M (WebGPU)",
    family: "Embedding",
    dtype: "q0f32",
    size: "540 MB",
    sizeBytes: 565_000_000,
    mlcModelLib: `${LIB_PREFIX}snowflake-arctic-embed-m-q0f32-ctx512_cs512_batch4-webgpu.wasm`,
    mlcVramRequiredMB: 540,
  },
};
