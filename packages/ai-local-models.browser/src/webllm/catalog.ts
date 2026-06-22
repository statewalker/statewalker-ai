import type { LocalModelConfig } from "@statewalker/ai-agent.core/models";

/**
 * WebLLM catalog. Only the function-calling-capable Hermes models are
 * listed — they are the only entries that survive an
 * `engine.chat.completions.create({ tools, ... })` call. Other models
 * throw `UnsupportedModelIdError` the moment the agent registers tools
 * (which it does on every turn that exercises skills), so they aren't
 * usable from chat-mini today.
 *
 * The list and per-model metadata are kept in sync with WebLLM's
 * `functionCallingModelIds` and `prebuiltAppConfig.model_list` from
 * `@mlc-ai/web-llm` v0.2.82.
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
  "webllm:hermes-3-llama-3.1-8b-q4f16": {
    runtime: "local",
    engine: "webllm",
    modelId: "mlc-ai/Hermes-3-Llama-3.1-8B-q4f16_1-MLC",
    label: "Hermes 3 · Llama 3.1-8B q4f16 (WebGPU)",
    family: "Hermes 3",
    dtype: "q4f16_1",
    size: "4.9 GB",
    sizeBytes: 5_242_880_000,
    mlcModelLib: ctx4k1k("Llama-3_1-8B-Instruct-q4f16_1"),
    mlcContextWindowSize: 4096,
    mlcVramRequiredMB: 4876,
  },
  "webllm:hermes-3-llama-3.1-8b-q4f32": {
    runtime: "local",
    engine: "webllm",
    modelId: "mlc-ai/Hermes-3-Llama-3.1-8B-q4f32_1-MLC",
    label: "Hermes 3 · Llama 3.1-8B q4f32 (WebGPU)",
    family: "Hermes 3",
    dtype: "q4f32_1",
    size: "6.5 GB",
    sizeBytes: 6_979_321_856,
    mlcModelLib: ctx4k1k("Llama-3_1-8B-Instruct-q4f32_1"),
    mlcContextWindowSize: 4096,
    mlcVramRequiredMB: 5779,
  },
  "webllm:hermes-2-pro-llama-3-8b-q4f16": {
    runtime: "local",
    engine: "webllm",
    modelId: "mlc-ai/Hermes-2-Pro-Llama-3-8B-q4f16_1-MLC",
    label: "Hermes 2 Pro · Llama 3-8B q4f16 (WebGPU)",
    family: "Hermes 2 Pro",
    dtype: "q4f16_1",
    size: "4.9 GB",
    sizeBytes: 5_242_880_000,
    mlcModelLib: ctx4k1k("Llama-3-8B-Instruct-q4f16_1"),
    mlcContextWindowSize: 4096,
    mlcVramRequiredMB: 4976,
  },
  "webllm:hermes-2-pro-llama-3-8b-q4f32": {
    runtime: "local",
    engine: "webllm",
    modelId: "mlc-ai/Hermes-2-Pro-Llama-3-8B-q4f32_1-MLC",
    label: "Hermes 2 Pro · Llama 3-8B q4f32 (WebGPU)",
    family: "Hermes 2 Pro",
    dtype: "q4f32_1",
    size: "6.5 GB",
    sizeBytes: 6_979_321_856,
    mlcModelLib: ctx4k1k("Llama-3-8B-Instruct-q4f32_1"),
    mlcContextWindowSize: 4096,
    mlcVramRequiredMB: 6051,
  },
  "webllm:hermes-2-pro-mistral-7b-q4f16": {
    runtime: "local",
    engine: "webllm",
    modelId: "mlc-ai/Hermes-2-Pro-Mistral-7B-q4f16_1-MLC",
    // Note: this model requires `shader-f16` GPU feature. WebLLM
    // surfaces a clear runtime error if the user's adapter doesn't
    // support it; we don't filter at the catalog level because there
    // is no `requiredFeatures` field on `LocalModelConfig` yet.
    label: "Hermes 2 Pro · Mistral 7B q4f16 (WebGPU, shader-f16)",
    family: "Hermes 2 Pro",
    dtype: "q4f16_1",
    size: "4.0 GB",
    sizeBytes: 4_294_967_296,
    mlcModelLib: ctx4k1k("Mistral-7B-Instruct-v0.3-q4f16_1"),
    mlcContextWindowSize: 4096,
    mlcVramRequiredMB: 4033,
  },
};
