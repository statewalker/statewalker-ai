import type { ProviderV3 } from "@ai-sdk/provider";
import {
  createRemoteProvider as createRemoteProviderImpl,
  type ProviderName,
} from "@statewalker/ai-agent/models";
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
  return createRemoteProviderImpl(name, {
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    headers: toHeaderRecord(options.headers),
  });
}
