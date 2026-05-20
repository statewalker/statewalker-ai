import type { Capability } from "@statewalker/ai-providers";

/**
 * Curated mapping from model-id pattern to capability tags. The
 * `/v1/models` endpoints of OpenAI, Anthropic, and Google do not
 * reliably surface capability metadata, so we tag locally. Unknown
 * ids default to `["chat"]` so exotic remote models remain usable
 * in chat without a curated entry — the composer dropdown filter
 * is `capabilities.includes("chat")`.
 *
 * Patterns are matched left-to-right; the first match wins. Use
 * lowercase substrings; we compare against `modelId.toLowerCase()`.
 */
interface CapabilityRule {
  match: (id: string) => boolean;
  capabilities: Capability[];
}

const RULES: CapabilityRule[] = [
  // ── Embeddings ─────────────────────────────────────────────
  {
    match: (id) =>
      id.startsWith("text-embedding-") ||
      id.includes("embedding-3") ||
      id.includes("text-embedding-ada"),
    capabilities: ["embedding"],
  },
  // Voyage AI embeddings.
  {
    match: (id) => id.startsWith("voyage-") && id.includes("embed"),
    capabilities: ["embedding"],
  },
  // Cohere embeddings.
  {
    match: (id) => id.startsWith("embed-"),
    capabilities: ["embedding"],
  },
  // Google embedding family.
  {
    match: (id) =>
      id.startsWith("text-embedding") ||
      id.startsWith("gemini-embedding") ||
      id === "textembedding-gecko",
    capabilities: ["embedding"],
  },

  // ── Image generation ───────────────────────────────────────
  {
    match: (id) => id.startsWith("dall-e") || id.startsWith("imagen") || id === "gpt-image",
    capabilities: ["image-gen"],
  },

  // ── Text-to-speech ─────────────────────────────────────────
  {
    match: (id) => id.startsWith("tts-") || id.includes("tts"),
    capabilities: ["tts"],
  },
];

/** Default for unknown model ids — chat-eligible. The composer
 * dropdown's filter is `capabilities.includes("chat")`. */
export const DEFAULT_CAPABILITIES: Capability[] = ["chat"];

/** Resolve the capability tags for a model id. Always returns at
 * least one tag (`["chat"]` is the default). */
export function capabilitiesFor(modelId: string): Capability[] {
  const id = modelId.toLowerCase();
  for (const rule of RULES) {
    if (rule.match(id)) return rule.capabilities;
  }
  return DEFAULT_CAPABILITIES;
}
