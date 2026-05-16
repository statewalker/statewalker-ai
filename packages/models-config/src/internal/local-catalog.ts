import type { LocalModelConfig } from "@statewalker/ai-agent/models";

/**
 * `LocalModelConfig` with an additional curated `description` field
 * rendered as Markdown in the Local Models dialog detail pane.
 */
export interface LocalModelEntry extends LocalModelConfig {
  description: string;
}

/**
 * Curated list of downloadable transformers.js models for chat-mini.
 * Mirrors the shapes commented out in
 * `@statewalker/ai-agent/models/model-catalog.ts` (kept commented
 * upstream so other apps don't drag in onnxruntime-web). Keys follow
 * the `local:` prefix convention so `ActiveModel.providerId ===
 * "local"` + `modelId === key` resolves to one of these entries.
 *
 * `dtype` is `q4` (not `q4f16`) because several onnx-community models
 * declare `transformers.js_config.kv_cache_dtype = { q4f16: "float16"
 * }` while their `model_q4f16.onnx` was actually exported with fp32
 * past_key_values inputs (OrtRun fails on the type mismatch). `q4`
 * loads `model_q4.onnx` whose KV inputs are fp32.
 */
export const localCatalog: Record<string, LocalModelEntry> = {
  "local:smollm2-135m": {
    runtime: "local",
    engine: "tjs",
    modelId: "HuggingFaceTB/SmolLM2-135M-Instruct",
    label: "SmolLM2-135M",
    family: "SmolLM2",
    dtype: "q4",
    size: "112 MB",
    sizeBytes: 117_440_512,
    description:
      "## SmolLM2-135M\nThe smallest member of the SmolLM2 family. Fits in browser memory on any device; fastest to load. Suitable for short prompts, lightweight summarisation, and offline experimentation.",
  },
  "local:smollm2-360m": {
    runtime: "local",
    engine: "tjs",
    modelId: "onnx-community/SmolLM2-360M-Instruct-ONNX",
    label: "SmolLM2-360M",
    family: "SmolLM2",
    dtype: "q4",
    size: "260 MB",
    sizeBytes: 272_629_760,
    description:
      "## SmolLM2-360M\nMid-tier SmolLM2 with noticeably better quality than 135M. Recommended default for browser-side chat when latency matters more than maximum quality.",
  },
  "local:smollm2-1.7b": {
    runtime: "local",
    engine: "tjs",
    modelId: "onnx-community/SmolLM2-1.7B-Instruct-ONNX",
    label: "SmolLM2-1.7B",
    family: "SmolLM2",
    dtype: "q4",
    size: "1.0 GB",
    sizeBytes: 1_073_741_824,
    description:
      "## SmolLM2-1.7B\nLargest SmolLM2 variant. Stronger reasoning at the cost of activation time and memory; expect 1-2s warm-up on first message.",
  },
  "local:qwen3.5-0.8b": {
    runtime: "local",
    engine: "tjs",
    modelId: "onnx-community/Qwen3.5-0.8B-Text-ONNX",
    label: "Qwen3.5-0.8B",
    family: "Qwen 3.5",
    dtype: "q4",
    size: "480 MB",
    sizeBytes: 503_316_480,
    description:
      "## Qwen3.5-0.8B\nLight Qwen 3.5 variant. Strong multilingual support, good code completion at small size. WASM-only on most browsers.",
  },
};

/** Array view used by the Local Models dialog and the Models List. */
export function localCatalogEntries(): readonly LocalModelEntry[] {
  return Object.values(localCatalog);
}
