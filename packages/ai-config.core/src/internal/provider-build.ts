import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { ProviderV3 } from "@ai-sdk/provider";
import type { ConnectionHeader, ConnectionType } from "../public/types.js";

export interface ProviderSettings {
  /** API key, read from `Secrets` by the caller — never from a Connection. */
  apiKey: string;
  /** Base URL override. Required for `openai-compatible`. */
  baseURL?: string;
  /** Headers forwarded on every outgoing call. */
  headers?: ConnectionHeader[];
}

function toHeaderRecord(
  headers: ConnectionHeader[] | undefined,
): Record<string, string> | undefined {
  if (!headers || headers.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const h of headers) {
    if (h.name) out[h.name] = h.value;
  }
  return out;
}

/**
 * Build a `ProviderV3` directly from `@ai-sdk/*` for one of the supported
 * connection types. Inlined here (rather than via `@statewalker/ai-agent`)
 * to keep `ai.config` free of any `@statewalker/ai-*` dependency — that edge
 * would form a workbench ↔ ai cycle.
 */
export function buildProvider(type: ConnectionType, settings: ProviderSettings): ProviderV3 {
  const sdkSettings = {
    apiKey: settings.apiKey,
    baseURL: settings.baseURL,
    headers: toHeaderRecord(settings.headers),
  };
  switch (type) {
    case "anthropic":
      return createAnthropic(sdkSettings);
    case "google":
      return createGoogleGenerativeAI(sdkSettings);
    case "openai":
      return createOpenAI(sdkSettings);
    case "openai-compatible":
      if (!settings.baseURL) {
        throw new Error("openai-compatible provider requires settings.baseURL");
      }
      return createOpenAI(sdkSettings);
    default:
      throw new Error(`Unknown connection type: ${type as string}`);
  }
}
