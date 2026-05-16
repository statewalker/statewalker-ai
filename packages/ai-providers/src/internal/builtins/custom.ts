import { createRemoteProvider } from "../../public/create-remote-provider.js";
import type { Connection } from "../../public/providers-store.js";
import type { ProviderDescriptor, ProviderModelInfo } from "../../public/types.js";

/**
 * Build a `ProviderDescriptor` for a user-defined OpenAI-compatible
 * endpoint. Models are not enumerable from generic OpenAI-compatible
 * endpoints (no canonical /models route guaranteed); when the
 * Connection has a refreshed `discoveredModels` cache the descriptor
 * returns it, otherwise an empty list — the picker falls back to
 * free-text input.
 */
export function buildCustomDescriptor(c: Connection): ProviderDescriptor {
  if (!c.url) {
    throw new Error(`openai-compatible Connection ${c.id} requires a url (baseURL)`);
  }
  return {
    id: c.id,
    label: c.name || "Untitled",
    kind: "custom",
    createProvider: () =>
      createRemoteProvider("openai-compatible", {
        apiKey: c.apiKey,
        baseURL: c.url,
        headers: c.headers,
      }),
    listModels: (): readonly ProviderModelInfo[] =>
      c.discoveredModels?.map((m) => ({ id: m.id, label: m.label })) ?? [],
  };
}
