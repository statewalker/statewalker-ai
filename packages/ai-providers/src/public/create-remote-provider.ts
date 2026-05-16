import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { ProviderV3 } from "@ai-sdk/provider";
import type { ProviderName } from "@statewalker/ai-agent/models";
import type { ConnectionHeader } from "./providers-store.js";

export interface CreateRemoteProviderOptions {
  apiKey: string;
  /** Optional base URL override. Required for `openai-compatible`. */
  baseURL?: string;
  /** Additional headers forwarded on every outgoing call. */
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

/** Build a `ProviderV3` for one of the supported remote providers. */
export function createRemoteProvider(
  name: ProviderName,
  options: CreateRemoteProviderOptions,
): ProviderV3 {
  const { apiKey, baseURL } = options;
  const headers = toHeaderRecord(options.headers);
  switch (name) {
    case "anthropic":
      return createAnthropic({ apiKey, baseURL, headers });
    case "google":
      return createGoogleGenerativeAI({ apiKey, baseURL, headers });
    case "openai":
      return createOpenAI({ apiKey, baseURL, headers });
    case "openai-compatible":
      if (!baseURL) {
        throw new Error("openai-compatible provider requires a baseURL");
      }
      return createOpenAI({ apiKey, baseURL, headers });
    default: {
      const _exhaustive: never = name;
      throw new Error(`Unknown provider: ${_exhaustive as string}`);
    }
  }
}
