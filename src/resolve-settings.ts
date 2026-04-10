import type {
  ModelManager,
  RemoteModelConfig,
  RemoteProviderSettings,
} from "@statewalker/ai-provider";
import { getProviderApiKeys } from "./adapters.js";

/**
 * Resolves RemoteProviderSettings (apiKey) for a catalog key by looking up
 * the provider in the stored API keys map.
 * Returns undefined for local models (they don't need settings).
 */
export function resolveActivationSettings(
  ctx: Record<string, unknown>,
  manager: ModelManager,
  catalogKey: string,
): RemoteProviderSettings | undefined {
  const state = manager.getState(catalogKey);
  if (!state || state.config.runtime !== "remote") return undefined;

  const provider = (state.config as RemoteModelConfig).provider;
  const apiKeys = getProviderApiKeys(ctx);
  const apiKey = apiKeys[provider];

  if (!apiKey) return undefined;
  return { apiKey };
}
