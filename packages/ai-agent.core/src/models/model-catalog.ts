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
