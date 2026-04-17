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

    // ── Local models (transformers.js) ─────────────────────────────────────
    // SmolLM2
    "local:smollm2-135m": {
      runtime: "local",
      engine: "tjs",
      modelId: "HuggingFaceTB/SmolLM2-135M-Instruct",
      label: "SmolLM2-135M",
      family: "SmolLM2",
      dtype: "q4f16",
      size: "112 MB",
      sizeBytes: 117_440_512,
    },
    "local:smollm2-360m": {
      runtime: "local",
      engine: "tjs",
      modelId: "onnx-community/SmolLM2-360M-Instruct-ONNX",
      label: "SmolLM2-360M",
      family: "SmolLM2",
      dtype: "q4f16",
      size: "260 MB",
      sizeBytes: 272_629_760,
    },
    "local:smollm2-1.7b": {
      runtime: "local",
      engine: "tjs",
      modelId: "onnx-community/SmolLM2-1.7B-Instruct-ONNX",
      label: "SmolLM2-1.7B",
      family: "SmolLM2",
      dtype: "q4f16",
      size: "1.0 GB",
      sizeBytes: 1_073_741_824,
    },

    // Qwen 3.5
    "local:qwen3.5-0.8b": {
      runtime: "local",
      engine: "tjs",
      modelId: "onnx-community/Qwen3.5-0.8B-Text-ONNX",
      label: "Qwen3.5-0.8B",
      family: "Qwen 3.5",
      dtype: "q4f16",
      size: "480 MB",
      sizeBytes: 503_316_480,
    },
    "local:qwen3.5-2b": {
      runtime: "local",
      engine: "tjs",
      modelId: "onnx-community/Qwen3.5-2B-ONNX",
      label: "Qwen3.5-2B",
      family: "Qwen 3.5",
      dtype: "q4f16",
      size: "1.2 GB",
      sizeBytes: 1_288_490_188,
    },
    "local:qwen3.5-4b": {
      runtime: "local",
      engine: "tjs",
      modelId: "onnx-community/Qwen3.5-4B-ONNX",
      label: "Qwen3.5-4B",
      family: "Qwen 3.5",
      dtype: "q4f16",
      size: "2.4 GB",
      sizeBytes: 2_576_980_377,
    },

    // Phi
    "local:phi-3.5-mini": {
      runtime: "local",
      engine: "tjs",
      modelId: "onnx-community/Phi-3.5-mini-instruct-onnx-web",
      label: "Phi-3.5-mini",
      family: "Phi",
      dtype: "q4",
      size: "2.4 GB",
      sizeBytes: 2_576_980_377,
    },

    // Llama
    "local:llama-3.2-1b": {
      runtime: "local",
      engine: "tjs",
      modelId: "onnx-community/Llama-3.2-1B-Instruct",
      label: "Llama 3.2-1B",
      family: "Llama",
      dtype: "q4f16",
      size: "650 MB",
      sizeBytes: 681_574_400,
    },
    "local:llama-3.2-3b": {
      runtime: "local",
      engine: "tjs",
      modelId: "onnx-community/Llama-3.2-3B-Instruct",
      label: "Llama 3.2-3B",
      family: "Llama",
      dtype: "q4f16",
      size: "1.8 GB",
      sizeBytes: 1_932_735_283,
    },

    // DeepSeek
    "local:deepseek-r1-1.5b": {
      runtime: "local",
      engine: "tjs",
      modelId: "onnx-community/DeepSeek-R1-Distill-Qwen-1.5B",
      label: "DeepSeek-R1 1.5B",
      family: "DeepSeek",
      dtype: "q4f16",
      size: "900 MB",
      sizeBytes: 943_718_400,
    },
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
