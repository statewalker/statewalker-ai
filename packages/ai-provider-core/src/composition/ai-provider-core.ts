import { getWorkspace } from "@statewalker/workspace-api";
import {
  ActiveEmbeddingModelImpl,
  ActiveReasoningModelImpl,
  FilesBackedProviderSettingsStore,
  ModelManagerAdapter,
} from "./adapters.impl.js";
import {
  ActiveEmbeddingModel,
  ActiveReasoningModel,
  ModelManager,
  ProviderSettingsStore,
} from "./adapters.js";
import { registerIntentHandlers } from "./intent-handlers.js";

/**
 * Activator for the AI provider fragment.
 *
 * Registers the four workspace-adapter tokens (ModelManager,
 * ProviderSettingsStore, ActiveReasoningModel, ActiveEmbeddingModel) on
 * the workspace.
 *
 * Adapter construction is lazy — `requireAdapter(X)` builds the
 * concrete impl on first access. File-backed impls subscribe to
 * `workspace.onLoad` internally and only touch FilesApi after the
 * workspace is opened (typical pattern for fragments that depend on
 * the workspace's primary file system).
 *
 * Configurator panel mount and the 16-intent surface land in §4-§9 of
 * the ai-provider-core-reshape change. The legacy 4-intent controllers
 * (`composition/legacy-controllers.ts`) are NOT wired by this activator
 * — chat.* consumers must migrate to the new intent surface as part of
 * the change's Phase 6.
 */
export default function initAiProviderCore(ctx: Record<string, unknown>): () => void {
  const ws = getWorkspace(ctx);

  ws.setAdapter(ModelManager, ModelManagerAdapter)
    .setAdapter(ProviderSettingsStore, FilesBackedProviderSettingsStore)
    .setAdapter(ActiveReasoningModel, ActiveReasoningModelImpl)
    .setAdapter(ActiveEmbeddingModel, ActiveEmbeddingModelImpl);

  return registerIntentHandlers(ws);
}
