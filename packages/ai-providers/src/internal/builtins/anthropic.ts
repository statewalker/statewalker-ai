import { createDefaultCatalog } from "@statewalker/ai-agent/models";
import { createRemoteProvider } from "../../public/create-remote-provider.js";
import type {
  ProviderDescriptor,
  ProviderModelInfo,
} from "../../public/types.js";

function listAnthropicModels(): readonly ProviderModelInfo[] {
  const catalog = createDefaultCatalog();
  const out: ProviderModelInfo[] = [];
  for (const entry of Object.values(catalog)) {
    if (entry.runtime !== "remote") continue;
    if (entry.provider !== "anthropic") continue;
    out.push({
      id: entry.modelId,
      label: entry.label ?? entry.modelId,
    });
  }
  return out;
}

export function buildAnthropicDescriptor(apiKey: string): ProviderDescriptor {
  return {
    id: "anthropic",
    label: "Anthropic",
    kind: "canonical",
    createProvider: () => createRemoteProvider("anthropic", apiKey),
    listModels: listAnthropicModels,
  };
}
