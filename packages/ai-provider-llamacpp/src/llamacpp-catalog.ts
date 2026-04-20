import type { LocalModelConfig } from "@statewalker/ai-provider";

/**
 * Default catalog of llama.cpp models (GGUF, Q4_K_M). Merge into the app
 * catalog with `mergeCatalogs(createDefaultCatalog(), llamaCppCatalog)`
 * in Node processes.
 *
 * Sizes are from each repo's file listing; GGUF files live under
 * `https://huggingface.co/{modelId}/resolve/main/{ggufFile}`.
 */
export const llamaCppCatalog: Record<string, LocalModelConfig> = {
  "llamacpp:llama-3.2-3b-q4": {
    runtime: "local",
    engine: "llamacpp",
    modelId: "bartowski/Llama-3.2-3B-Instruct-GGUF",
    label: "Llama 3.2-3B Instruct (Q4_K_M)",
    family: "Llama 3.2",
    dtype: "Q4_K_M",
    size: "2.0 GB",
    sizeBytes: 2_019_377_344,
    ggufFile: "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
    ggufNCtx: 4096,
  },
  "llamacpp:qwen-2.5-3b-q4": {
    runtime: "local",
    engine: "llamacpp",
    modelId: "bartowski/Qwen2.5-3B-Instruct-GGUF",
    label: "Qwen 2.5-3B Instruct (Q4_K_M)",
    family: "Qwen 2.5",
    dtype: "Q4_K_M",
    size: "1.9 GB",
    sizeBytes: 1_929_911_296,
    ggufFile: "Qwen2.5-3B-Instruct-Q4_K_M.gguf",
    ggufNCtx: 4096,
  },
  "llamacpp:phi-3.5-mini-q4": {
    runtime: "local",
    engine: "llamacpp",
    modelId: "bartowski/Phi-3.5-mini-instruct-GGUF",
    label: "Phi 3.5-mini Instruct (Q4_K_M)",
    family: "Phi",
    dtype: "Q4_K_M",
    size: "2.4 GB",
    sizeBytes: 2_393_232_064,
    ggufFile: "Phi-3.5-mini-instruct-Q4_K_M.gguf",
    ggufNCtx: 4096,
  },
};
