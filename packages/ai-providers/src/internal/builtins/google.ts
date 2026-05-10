import { createDefaultCatalog } from "@statewalker/ai-agent/models";
import { createRemoteProvider } from "../../public/create-remote-provider.js";
import type {
  ProviderDescriptor,
  ProviderModelInfo,
} from "../../public/types.js";

function listGoogleModels(): readonly ProviderModelInfo[] {
  const catalog = createDefaultCatalog();
  const out: ProviderModelInfo[] = [];
  for (const entry of Object.values(catalog)) {
    if (entry.runtime !== "remote") continue;
    if (entry.provider !== "google") continue;
    out.push({
      id: entry.modelId,
      label: entry.label ?? entry.modelId,
    });
  }
  return out;
}

export function buildGoogleDescriptor(apiKey: string): ProviderDescriptor {
  return {
    id: "google",
    label: "Google",
    kind: "canonical",
    createProvider: () => createRemoteProvider("google", apiKey),
    listModels: listGoogleModels,
  };
}
