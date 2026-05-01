import { newRegistry } from "@statewalker/shared-registry";
import { getWorkspace } from "@statewalker/workspace-api";
import {
  ActiveEmbeddingModelImpl,
  ActiveReasoningModelImpl,
  FilesBackedProviderSettingsStore,
  ModelManagerAdapter,
} from "../internal/adapters.impl.js";
import { AiConfigManager } from "../internal/ai-config.manager.js";
import { registerIntentHandlers } from "../internal/handlers/register-handlers.js";
import {
  ActiveEmbeddingModel,
  ActiveReasoningModel,
  ModelManager,
  ProviderSettingsStore,
} from "./adapters.js";

/**
 * Activator for the AI provider fragment.
 *
 * Registers the four workspace-adapter tokens (ModelManager,
 * ProviderSettingsStore, ActiveReasoningModel, ActiveEmbeddingModel),
 * constructs the configurator manager (which publishes its own dock
 * panel), and registers the intent-handler surface. The returned
 * cleanup tears down all of the above.
 */
export default function initAiProviderCore(ctx: Record<string, unknown>): () => void {
  const ws = getWorkspace(ctx);
  const [register, cleanup] = newRegistry();

  ws.setAdapter(ModelManager, ModelManagerAdapter)
    .setAdapter(ProviderSettingsStore, FilesBackedProviderSettingsStore)
    .setAdapter(ActiveReasoningModel, ActiveReasoningModelImpl)
    .setAdapter(ActiveEmbeddingModel, ActiveEmbeddingModelImpl);

  const manager = new AiConfigManager({ workspace: ws });
  register(() => manager.close());
  register(registerIntentHandlers(ws));

  return cleanup;
}
