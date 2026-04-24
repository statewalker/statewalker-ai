import type {
  ModelManager,
  ModelState,
  RemoteModelConfig,
  RemoteProviderSettings,
} from "@statewalker/ai-provider";
import { modelKinds } from "@statewalker/ai-provider";
import { newAdapter } from "@statewalker/shared-adapters";
import { newRegistry } from "@statewalker/shared-registry";
import type { FilesApi } from "@statewalker/webrun-files";
import { getModelManager } from "../adapters.js";
import { detectAvailableEngines, type EngineAvailability } from "../engine-detection.js";
import { type ProviderSettings, ProviderSettingsStore } from "../provider-settings-store.js";
import { getModelListView } from "./model-settings.controller.js";

/**
 * FilesApi to use for providers.json. Defaults to ModelManager.files if
 * set, otherwise must be provided via `setActiveModelsFilesApi`.
 */
export const [getActiveModelsFilesApi, setActiveModelsFilesApi] = newAdapter<FilesApi>(
  "api:active-models-files",
  (ctx) => {
    const manager = getModelManager(ctx as Record<string, unknown>);
    if (!manager.files) {
      throw new Error(
        "active-models-lifecycle requires a FilesApi (either on the ModelManager or via setActiveModelsFilesApi)",
      );
    }
    return manager.files;
  },
);

/**
 * Persistence + startup re-activation for active reasoning/embedding models.
 *
 * - Loads `providers.json` at startup and hydrates `ModelStateStore` provider
 *   settings from it.
 * - Iterates `activeModels.reasoning` then `activeModels.embedding` and
 *   re-activates each sequentially. Failures are logged but do NOT remove
 *   the entry from disk — the next successful activation will clear it.
 * - Subscribes to store updates and writes the derived `activeModels` set
 *   back to disk (debounced via ProviderSettingsStore.save).
 * - Recomputes the shared `ModelListView` after each flush so the settings
 *   panel reflects the latest state.
 */
export function createActiveModelsLifecycleController(
  ctx: Record<string, unknown>,
): () => Promise<void> {
  const [register, cleanup] = newRegistry();
  const manager = getModelManager(ctx);
  const files = getActiveModelsFilesApi(ctx);
  const store = new ProviderSettingsStore(files);
  register(() => store.dispose());

  const listView = getModelListView(ctx);

  // Snapshot of provider settings and activeModels loaded from disk;
  // kept mutable so subsequent saves merge correctly.
  let settings: ProviderSettings = {};
  let availableEngines: EngineAvailability | undefined;

  const refreshListView = () => {
    listView.recompute(
      manager.store.getStates(),
      settings,
      settings.activeModels ?? { reasoning: [], embedding: [] },
      availableEngines,
    );
  };

  // Kick off async startup
  void (async () => {
    const [loaded, engines] = await Promise.all([store.load(), detectAvailableEngines()]);
    settings = loaded;
    availableEngines = engines;
    hydrateProviderSettings(manager, settings);
    refreshListView();

    await reactivate(manager, settings);
    refreshListView();

    // Only attach the write-through listener after startup re-activation
    // completes; otherwise the hydration-driven notifications would echo
    // back into a pointless save.
    register(
      manager.store.onUpdate(() => {
        const derived = deriveActiveModels(manager.store.getStates());
        settings = {
          ...settings,
          activeModels: derived,
        };
        store.save(settings);
        refreshListView();
      }),
    );
  })();

  return cleanup;
}

/**
 * Copy every configured provider entry into the runtime ModelStateStore so
 * `resolveActivationSettings` can find credentials.
 */
function hydrateProviderSettings(manager: ModelManager, settings: ProviderSettings): void {
  for (const name of ["anthropic", "google", "openai"] as const) {
    const entry = settings[name];
    if (entry?.apiKey) {
      const runtimeSettings: RemoteProviderSettings = { apiKey: entry.apiKey };
      if (entry.baseURL) runtimeSettings.baseURL = entry.baseURL;
      manager.store.setProviderSettings(name, runtimeSettings);
    }
  }
  const compat = settings["openai-compatible"] ?? {};
  for (const [instanceId, entry] of Object.entries(compat)) {
    const runtimeSettings: RemoteProviderSettings = { baseURL: entry.baseURL };
    if (entry.apiKey) runtimeSettings.apiKey = entry.apiKey;
    manager.store.setProviderSettings("openai-compatible", runtimeSettings, instanceId);
  }
}

/**
 * Re-activate every key in `activeModels.reasoning` then `.embedding`,
 * sequentially. Missing-credential or absent-from-catalog entries are
 * skipped with a warning but retained in `activeModels` on disk.
 */
async function reactivate(manager: ModelManager, settings: ProviderSettings): Promise<void> {
  const am = settings.activeModels ?? { reasoning: [], embedding: [] };
  for (const key of [...am.reasoning, ...am.embedding]) {
    const state = manager.store.getState(key);
    if (!state) {
      console.warn(`[active-models] startup skip: catalog entry ${key} is not loaded`);
      continue;
    }
    if (state.config.runtime === "remote") {
      const cfg = state.config as RemoteModelConfig;
      const rs = manager.store.getProviderSettings(cfg.provider, cfg.providerInstanceId);
      if (!rs?.apiKey && !rs?.baseURL) {
        console.warn(`[active-models] startup skip: no credentials for ${key}`);
        continue;
      }
      try {
        for await (const p of manager.activate(key, { settings: rs })) {
          if (p.phase === "error") break;
        }
      } catch (err) {
        console.warn(`[active-models] startup re-activation failed for ${key}`, err);
      }
    } else {
      // Local — only re-activate when weights are present.
      if (state.status !== "downloaded" && state.status !== "ready") {
        console.warn(`[active-models] startup skip: ${key} weights not downloaded`);
        continue;
      }
      try {
        for await (const p of manager.activate(key)) {
          if (p.phase === "error") break;
        }
      } catch (err) {
        console.warn(`[active-models] startup re-activation failed for ${key}`, err);
      }
    }
  }
}

/**
 * Derive the `activeModels` set from the current ModelStateStore: a model
 * counts if its status is "ready" and its `kinds` include that role.
 */
function deriveActiveModels(states: ReadonlyMap<string, ModelState>): {
  reasoning: string[];
  embedding: string[];
} {
  const reasoning: string[] = [];
  const embedding: string[] = [];
  for (const [key, state] of states) {
    if (state.status !== "ready") continue;
    const kinds = modelKinds(state.config);
    if (kinds.includes("reasoning")) reasoning.push(key);
    if (kinds.includes("embedding")) embedding.push(key);
  }
  return { reasoning, embedding };
}
