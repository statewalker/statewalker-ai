import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { FilesApi } from "@statewalker/webrun-files";

// ── Model configuration ────────────────────────────────────────────────────

export type ModelRuntime = "remote" | "local";

export interface RemoteModelConfig {
  runtime: "remote";
  /** Vercel AI SDK provider name, or "openai-compatible" for custom endpoints */
  provider: ProviderName;
  /** Disambiguator when `provider === "openai-compatible"` and multiple custom instances coexist. */
  providerInstanceId?: string;
  /** Provider-specific model ID, e.g. "claude-sonnet-4-20250514" */
  modelId: string;
  /** Human-readable display name */
  label: string;
  /** Roles this model is eligible for. Omitted ≡ ["reasoning"]. */
  kinds?: ModelKind[];
}

/** Identifier for the engine that runs a local model. */
export type EngineId = "tjs" | "webllm" | "llamacpp";

export interface LocalModelConfig {
  runtime: "local";
  /** Which local inference engine evaluates this model. */
  engine: EngineId;
  /** HuggingFace model ID, e.g. "onnx-community/Qwen3.5-2B-ONNX" */
  modelId: string;
  /** Human-readable display name */
  label: string;
  /** Model family, e.g. "SmolLM2", "Qwen 3.5" */
  family: string;
  /** Quantization dtype for transformers.js, e.g. "q4f16" */
  dtype: string;
  /** Human-readable download size, e.g. "1.2 GB" */
  size: string;
  /** Approximate size in bytes (for progress calculation) */
  sizeBytes: number;
  /** Max new tokens for generation (default 512) */
  maxNewTokens?: number;
  /** Roles this model is eligible for. Omitted ≡ ["reasoning"]. */
  kinds?: ModelKind[];

  // ── WebLLM (engine: "webllm") ────────────────────────────────────────────
  /** URL to the MLC-compiled .wasm library for this model. */
  mlcModelLib?: string;
  /** Override for mlc-chat-config.json context_window_size. */
  mlcContextWindowSize?: number;
  /** Estimated VRAM in MB required to run this model on WebGPU. */
  mlcVramRequiredMB?: number;

  // ── llama.cpp (engine: "llamacpp") ───────────────────────────────────────
  /** Single GGUF file name within the HuggingFace repo. */
  ggufFile?: string;
  /** Context window size for the llama.cpp context. */
  ggufNCtx?: number;
  /** Number of layers offloaded to GPU (0 = CPU only). */
  ggufNGpuLayers?: number;
}

export type ModelConfig = RemoteModelConfig | LocalModelConfig;

/** Role a model is eligible for. */
export type ModelKind = "reasoning" | "embedding";

/** The canonical roles that apply when `ModelConfig.kinds` is omitted. */
export const DEFAULT_MODEL_KINDS: ModelKind[] = ["reasoning"];

/** Returns the effective `kinds` for a model, defaulting to `["reasoning"]`. */
export function modelKinds(config: ModelConfig): ModelKind[] {
  return config.kinds ?? DEFAULT_MODEL_KINDS;
}

// ── Remote provider settings ───────────────────────────────────────────────

export type ProviderName = "google" | "anthropic" | "openai" | "openai-compatible";

export const PROVIDER_NAMES: ProviderName[] = [
  "google",
  "anthropic",
  "openai",
  "openai-compatible",
];

/** Canonical providers — the three with first-class SDK support. */
export const CANONICAL_PROVIDER_NAMES: Exclude<ProviderName, "openai-compatible">[] = [
  "google",
  "anthropic",
  "openai",
];

/**
 * Common settings for creating a remote AI provider.
 * Maps to the shared fields of OpenAIProviderSettings,
 * AnthropicProviderSettings, GoogleGenerativeAIProviderSettings.
 */
export interface RemoteProviderSettings {
  /** API key for authentication. */
  apiKey?: string;
  /** Auth token sent as Bearer header (alternative to apiKey). */
  authToken?: string;
  /** Custom base URL for API calls (e.g. for proxy servers). */
  baseURL?: string;
  /** Custom headers to include in requests. */
  headers?: Record<string, string>;
  /** Custom fetch implementation (e.g. for testing or middleware). */
  fetch?: typeof globalThis.fetch;
  /** Custom ID generator. */
  generateId?: () => string;
}

// ── Activation progress ────────────────────────────────────────────────────

export type ActivationPhase =
  | "verifying" // remote: checking API key
  | "checking" // local: checking if weights exist in storage
  | "downloading" // local: downloading weights from HuggingFace
  | "loading" // local: loading model into memory (WebGPU/WASM)
  | "warming" // local: running warm-up inference
  | "ready" // model is ready for use
  | "error"; // activation failed

export interface ActivationProgress {
  modelKey: string;
  phase: ActivationPhase;
  /** 0..1 progress within the current phase */
  progress?: number;
  /** Bytes downloaded so far (download phase only) */
  bytesDownloaded?: number;
  /** Total bytes to download (download phase only) */
  bytesTotal?: number;
  /** Human-readable status message */
  message: string;
  /** Error details if phase === "error" */
  error?: Error;
}

// ── Model status ───────────────────────────────────────────────────────────

export type ModelStatus =
  | "not-downloaded" // local: weights not in storage
  | "downloading" // local: weights currently being downloaded
  | "partial" // local: download was interrupted, partial files on disk (resumable)
  | "downloaded" // local: weights in storage but not loaded
  | "loading" // currently activating (loading into memory)
  | "ready" // model is loaded and ready
  | "error"; // last activation failed

export interface ModelState {
  config: ModelConfig;
  status: ModelStatus;
  error?: Error;
}

// ── Plugin factory ─────────────────────────────────────────────────────────

/**
 * Factory function for creating local LanguageModelV1 instances.
 * Called by ModelManager when activating a local model.
 *
 * @param modelId - HuggingFace model ID
 * @param config - Local model configuration
 * @param files - FilesApi for reading stored model weights
 * @param onProgress - Callback for reporting activation progress
 * @param signal - Abort signal for cancellation
 */
export type LocalModelFactory = (
  modelId: string,
  config: LocalModelConfig,
  files: FilesApi,
  onProgress: (progress: ActivationProgress) => void,
  signal?: AbortSignal,
) => Promise<LanguageModelV3>;
