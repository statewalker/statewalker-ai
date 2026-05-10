import type { ModelConfig } from "./types.js";

/**
 * Returns the default model catalog with known transformers.js models
 * and common remote model entries.
 */
export function createDefaultCatalog(): Record<string, ModelConfig> {
  return {
    // ── Remote models ──────────────────────────────────────────────────────
    "anthropic:claude-sonnet": {
      runtime: "remote",
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      label: "Claude Sonnet",
    },
    "anthropic:claude-haiku": {
      runtime: "remote",
      provider: "anthropic",
      modelId: "claude-haiku-4-5-20251001",
      label: "Claude Haiku",
    },
    "google:gemini-2.5-flash": {
      runtime: "remote",
      provider: "google",
      modelId: "gemini-2.5-flash",
      label: "Gemini 2.5 Flash",
    },
    "google:gemini-2.5-pro": {
      runtime: "remote",
      provider: "google",
      modelId: "gemini-2.5-pro",
      label: "Gemini 2.5 Pro",
    },
    "openai:gpt-4o": {
      runtime: "remote",
      provider: "openai",
      modelId: "gpt-4o",
      label: "GPT-4o",
    },
    "openai:gpt-4o-mini": {
      runtime: "remote",
      provider: "openai",
      modelId: "gpt-4o-mini",
      label: "GPT-4o Mini",
    },

    // ── Local models (transformers.js) — temporarily disabled ──────────────
    // All local entries are commented out so the chat-mini bundle drops the
    // transformers.js / onnxruntime-web runtime + WASM binary entirely.
    // Re-enable individual entries by uncommenting + restoring the
    // `registerTransformersProvider` import in chat-mini's runtime-context
    // and the export in @statewalker/ai-provider-browser/src/index.ts.
    //
    // dtype is "q4" (not "q4f16") because several onnx-community models
    // declare `transformers.js_config.kv_cache_dtype = { q4f16: "float16" }`
    // while their `model_q4f16.onnx` was actually exported with fp32
    // past_key_values inputs. The mismatch fails at OrtRun:
    //   `Unexpected input data type. Actual: (tensor(float16)), expected:
    //    (tensor(float))`
    // `q4` loads `model_q4.onnx` whose KV inputs are fp32 across these
    // models, so initialization matches the file signature.
    //
    // // SmolLM2
    // "local:smollm2-135m": {
    //   runtime: "local",
    //   engine: "tjs",
    //   modelId: "HuggingFaceTB/SmolLM2-135M-Instruct",
    //   label: "SmolLM2-135M",
    //   family: "SmolLM2",
    //   dtype: "q4",
    //   size: "112 MB",
    //   sizeBytes: 117_440_512,
    // },
    // "local:smollm2-360m": {
    //   runtime: "local",
    //   engine: "tjs",
    //   modelId: "onnx-community/SmolLM2-360M-Instruct-ONNX",
    //   label: "SmolLM2-360M",
    //   family: "SmolLM2",
    //   dtype: "q4",
    //   size: "260 MB",
    //   sizeBytes: 272_629_760,
    // },
    // "local:smollm2-1.7b": {
    //   runtime: "local",
    //   engine: "tjs",
    //   modelId: "onnx-community/SmolLM2-1.7B-Instruct-ONNX",
    //   label: "SmolLM2-1.7B",
    //   family: "SmolLM2",
    //   dtype: "q4",
    //   size: "1.0 GB",
    //   sizeBytes: 1_073_741_824,
    // },
    //
    // // Qwen 3.5
    // "local:qwen3.5-0.8b": {
    //   runtime: "local",
    //   engine: "tjs",
    //   modelId: "onnx-community/Qwen3.5-0.8B-Text-ONNX",
    //   label: "Qwen3.5-0.8B",
    //   family: "Qwen 3.5",
    //   dtype: "q4",
    //   size: "480 MB",
    //   sizeBytes: 503_316_480,
    // },
    // "local:qwen3.5-2b": {
    //   runtime: "local",
    //   engine: "tjs",
    //   modelId: "onnx-community/Qwen3.5-2B-ONNX",
    //   label: "Qwen3.5-2B",
    //   family: "Qwen 3.5",
    //   dtype: "q4",
    //   size: "1.2 GB",
    //   sizeBytes: 1_288_490_188,
    // },
    // "local:qwen3.5-4b": {
    //   runtime: "local",
    //   engine: "tjs",
    //   modelId: "onnx-community/Qwen3.5-4B-ONNX",
    //   label: "Qwen3.5-4B",
    //   family: "Qwen 3.5",
    //   dtype: "q4",
    //   size: "2.4 GB",
    //   sizeBytes: 2_576_980_377,
    // },
    //
    // // Phi
    // "local:phi-3.5-mini": {
    //   runtime: "local",
    //   engine: "tjs",
    //   modelId: "onnx-community/Phi-3.5-mini-instruct-onnx-web",
    //   label: "Phi-3.5-mini",
    //   family: "Phi",
    //   dtype: "q4",
    //   size: "2.4 GB",
    //   sizeBytes: 2_576_980_377,
    // },
    //
    // // Llama
    // "local:llama-3.2-1b": {
    //   runtime: "local",
    //   engine: "tjs",
    //   modelId: "onnx-community/Llama-3.2-1B-Instruct",
    //   label: "Llama 3.2-1B",
    //   family: "Llama",
    //   dtype: "q4",
    //   size: "650 MB",
    //   sizeBytes: 681_574_400,
    // },
    // "local:llama-3.2-3b": {
    //   runtime: "local",
    //   engine: "tjs",
    //   modelId: "onnx-community/Llama-3.2-3B-Instruct",
    //   label: "Llama 3.2-3B",
    //   family: "Llama",
    //   dtype: "q4",
    //   size: "1.8 GB",
    //   sizeBytes: 1_932_735_283,
    // },
    //
    // // Gemma
    // "local:gemma-4-e2b": {
    //   runtime: "local",
    //   engine: "tjs",
    //   modelId: "onnx-community/gemma-4-E2B-it-ONNX",
    //   label: "Gemma 4 E2B",
    //   family: "Gemma",
    //   dtype: "q4",
    //   size: "3.9 GB",
    //   sizeBytes: 4_187_593_113,
    // },
    //
    // // DeepSeek
    // "local:deepseek-r1-1.5b": {
    //   runtime: "local",
    //   engine: "tjs",
    //   modelId: "onnx-community/DeepSeek-R1-Distill-Qwen-1.5B",
    //   label: "DeepSeek-R1 1.5B",
    //   family: "DeepSeek",
    //   dtype: "q4",
    //   size: "900 MB",
    //   sizeBytes: 943_718_400,
    // },
  };
}

/**
 * Merge catalogs left-to-right. Later catalogs override earlier ones for the
 * same key. Engine-specific fields on `LocalModelConfig` are preserved as-is
 * (standard object spread — no field-level merging).
 */
export function mergeCatalogs(
  ...catalogs: Array<Record<string, ModelConfig>>
): Record<string, ModelConfig> {
  return Object.assign({}, ...catalogs);
}
