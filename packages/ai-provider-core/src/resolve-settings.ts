import type {
  ModelManager,
  RemoteModelConfig,
  RemoteProviderSettings,
} from "@statewalker/ai-provider";

/**
 * Resolves RemoteProviderSettings (apiKey, baseURL) for a catalog key by
 * looking up the provider in the store's provider settings.
 * Returns undefined for local models (they don't need settings).
 */
export function resolveActivationSettings(
  _ctx: Record<string, unknown>,
  manager: ModelManager,
  catalogKey: string,
): RemoteProviderSettings | undefined {
  const state = manager.store.getState(catalogKey);
  if (!state || state.config.runtime !== "remote") return undefined;

  const config = state.config as RemoteModelConfig;
  return manager.store.getProviderSettings(config.provider, config.providerInstanceId);
}
