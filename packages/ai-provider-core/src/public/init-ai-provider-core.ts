import { newRegistry } from "@statewalker/shared-registry";
import { getWorkspace } from "@statewalker/workspace-api";
import {
  ActiveEmbeddingModelImpl,
  ActiveReasoningModelImpl,
  FilesBackedProviderSettingsStore,
  ModelManagerAdapter,
} from "../internal/adapters.impl.js";
import { registerIntentHandlers } from "../internal/handlers/register-handlers.js";
import { mountConfigPanel } from "../internal/mount-config-panel.js";
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
 * ProviderSettingsStore, ActiveReasoningModel, ActiveEmbeddingModel) on
 * the workspace, then mounts the configurator dock panel + the
 * intent-handler surface.
 *
 * Adapter construction is lazy — `requireAdapter(X)` builds the
 * concrete impl on first access. File-backed impls subscribe to
 * `workspace.onLoad` internally and only touch FilesApi after the
 * workspace is opened (typical pattern for fragments that depend on
 * the workspace's primary file system).
 */
export default function initAiProviderCore(ctx: Record<string, unknown>): () => void {
  const ws = getWorkspace(ctx);
  const [register, cleanup] = newRegistry();

  ws.setAdapter(ModelManager, ModelManagerAdapter)
    .setAdapter(ProviderSettingsStore, FilesBackedProviderSettingsStore)
    .setAdapter(ActiveReasoningModel, ActiveReasoningModelImpl)
    .setAdapter(ActiveEmbeddingModel, ActiveEmbeddingModelImpl);

  register(mountConfigPanel(ws));
  register(registerIntentHandlers(ws));

  return cleanup;
}
