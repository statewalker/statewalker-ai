import { createDefaultCatalog } from "@statewalker/ai-agent/models";
import { createRemoteProvider } from "../../public/create-remote-provider.js";
import type { Connection } from "../../public/providers-store.js";
import type { ProviderDescriptor, ProviderModelInfo } from "../../public/types.js";

function listAnthropicModels(): readonly ProviderModelInfo[] {
  const catalog = createDefaultCatalog();
  const out: ProviderModelInfo[] = [];
  for (const entry of Object.values(catalog)) {
    if (entry.runtime !== "remote") continue;
    if (entry.provider !== "anthropic") continue;
    out.push({ id: entry.modelId, label: entry.label ?? entry.modelId });
  }
  return out;
}

export function buildAnthropicDescriptor(c: Connection): ProviderDescriptor {
  return {
    id: c.id,
    label: c.name || "Anthropic",
    kind: "canonical",
    createProvider: () =>
      createRemoteProvider("anthropic", {
        apiKey: c.apiKey,
        baseURL: c.url,
        headers: c.headers,
      }),
    listModels: () =>
      c.discoveredModels && c.discoveredModels.length > 0
        ? c.discoveredModels.map((m) => ({ id: m.id, label: m.label }))
        : listAnthropicModels(),
  };
}
