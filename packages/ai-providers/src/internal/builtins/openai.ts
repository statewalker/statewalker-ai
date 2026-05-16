import { createDefaultCatalog } from "@statewalker/ai-agent/models";
import { createRemoteProvider } from "../../public/create-remote-provider.js";
import type { Connection } from "../../public/providers-store.js";
import type { ProviderDescriptor, ProviderModelInfo } from "../../public/types.js";

function listOpenAIModels(): readonly ProviderModelInfo[] {
  const catalog = createDefaultCatalog();
  const out: ProviderModelInfo[] = [];
  for (const entry of Object.values(catalog)) {
    if (entry.runtime !== "remote") continue;
    if (entry.provider !== "openai") continue;
    out.push({ id: entry.modelId, label: entry.label ?? entry.modelId });
  }
  return out;
}

export function buildOpenAIDescriptor(c: Connection): ProviderDescriptor {
  return {
    id: c.id,
    label: c.name || "OpenAI",
    kind: "canonical",
    createProvider: () =>
      createRemoteProvider("openai", {
        apiKey: c.apiKey,
        baseURL: c.url,
        headers: c.headers,
      }),
    listModels: () =>
      c.discoveredModels && c.discoveredModels.length > 0
        ? c.discoveredModels.map((m) => ({ id: m.id, label: m.label }))
        : listOpenAIModels(),
  };
}
