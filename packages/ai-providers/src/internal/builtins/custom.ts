import { createRemoteProvider } from "../../public/create-remote-provider.js";
import type { CustomProvider } from "../../public/providers-store.js";
import type {
  ProviderDescriptor,
  ProviderModelInfo,
} from "../../public/types.js";

/**
 * Build a `ProviderDescriptor` for a user-defined OpenAI-compatible
 * endpoint. Models are not enumerable from generic
 * OpenAI-compatible endpoints (no canonical /models route
 * guaranteed); the picker either lets the user type the model id or
 * relies on the descriptor's manual list once a fragment opts in.
 *
 * Returning an empty model list means the active-model picker for
 * this provider only shows what the user types.
 */
export function buildCustomDescriptor(
  custom: CustomProvider,
): ProviderDescriptor {
  return {
    id: custom.id,
    label: custom.name || "Untitled",
    kind: "custom",
    createProvider: () =>
      createRemoteProvider("openai-compatible", custom.apiKey, custom.baseURL),
    listModels: (): readonly ProviderModelInfo[] => [],
  };
}
