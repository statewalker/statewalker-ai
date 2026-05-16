import { createDefaultCatalog } from "@statewalker/ai-agent/models";
import { createRemoteProvider } from "../../public/create-remote-provider.js";
import type { Connection } from "../../public/providers-store.js";
import type { ProviderDescriptor, ProviderModelInfo } from "../../public/types.js";

function listGoogleModels(): readonly ProviderModelInfo[] {
  const catalog = createDefaultCatalog();
  const out: ProviderModelInfo[] = [];
  for (const entry of Object.values(catalog)) {
    if (entry.runtime !== "remote") continue;
    if (entry.provider !== "google") continue;
    out.push({ id: entry.modelId, label: entry.label ?? entry.modelId });
  }
  return out;
}

export function buildGoogleDescriptor(c: Connection): ProviderDescriptor {
  return {
    id: c.id,
    label: c.name || "Google",
    kind: "canonical",
    createProvider: () =>
      createRemoteProvider("google", {
        apiKey: c.apiKey,
        baseURL: c.url,
        headers: c.headers,
      }),
    listModels: () =>
      c.discoveredModels && c.discoveredModels.length > 0
        ? c.discoveredModels.map((m) => ({ id: m.id, label: m.label }))
        : listGoogleModels(),
  };
}
