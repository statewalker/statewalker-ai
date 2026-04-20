import { newRegistry } from "@statewalker/shared-registry";
import { getModelManager } from "../adapters.js";
import { restoreDownloadStatuses } from "../download-status-store.js";
import { migrateEngineNamespacing } from "../migrations.js";
import { resolveActivationSettings } from "../resolve-settings.js";

/**
 * Orchestrates the initial model activation flow.
 * If a model key is set (from stored settings), activates it in the background.
 *
 * Note: checking for missing provider keys and opening the settings dialog
 * is the responsibility of the host app (e.g. workspace controller),
 * which knows when settings have finished loading from storage.
 */
export function createStartupController(
  ctx: Record<string, unknown>,
): () => Promise<void> {
  const [, cleanup] = newRegistry();

  // Defer startup to allow all controllers to register first
  queueMicrotask(() => startup(ctx));

  return cleanup;
}

async function startup(ctx: Record<string, unknown>): Promise<void> {
  const manager = getModelManager(ctx);
  const store = manager.store;

  // Migrate legacy `/models/{modelId}/` layouts into
  // `/models/tjs/{modelId}/` before reading download metadata so both
  // refer to the same on-disk locations.
  if (manager.files) {
    await migrateEngineNamespacing(manager.files);
    await restoreDownloadStatuses(manager.files, store);
  }

  const activeKey = store.activeModelKey;
  if (!activeKey) return;

  try {
    const state = store.getState(activeKey);
    if (!state || state.status === "ready") return;

    const settings = resolveActivationSettings(ctx, manager, activeKey);
    for await (const p of manager.activate(activeKey, { settings })) {
      if (p.phase === "error") break;
    }

    // Confirm the active model key label matches after activation
    const updatedState = store.getState(activeKey);
    if (updatedState?.status === "ready") {
      store.setActiveModelKey(activeKey, updatedState.config.label);
    }
  } catch {
    // Non-blocking — errors are reflected in the model picker via store state
  }
}
