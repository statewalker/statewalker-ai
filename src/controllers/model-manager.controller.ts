import { newRegistry } from "@repo/shared/registry";
import { getModelManager } from "../adapters.js";
import {
  getIntents,
  handleActivateModel,
  handleGetActiveModel,
} from "../intents.js";
import { resolveActivationSettings } from "../resolve-settings.js";

/**
 * Handles model activation lifecycle intents.
 * Delegates to ModelManager for the actual activation work,
 * and reads from ModelStateStore for state queries.
 *
 * Prerequisites: ModelManager must be set on context before this runs.
 */
export function createModelManagerController(
  ctx: Record<string, unknown>,
): () => Promise<void> {
  const [register, cleanup] = newRegistry();
  const intents = getIntents(ctx);

  // ── Handle: activate-model ──────────────────────────────────
  register(
    handleActivateModel(intents, (intent) => {
      const manager = getModelManager(ctx);
      const store = manager.store;
      const { catalogKey } = intent.payload;

      (async () => {
        try {
          const settings = resolveActivationSettings(ctx, manager, catalogKey);
          for await (const p of manager.activate(catalogKey, { settings })) {
            if (p.phase === "error") {
              intent.reject(p.error ?? new Error(p.message));
              return;
            }
          }
          const model = store.getLanguageModel(catalogKey);
          const state = store.getState(catalogKey);
          store.setActiveModelKey(
            catalogKey,
            state?.config.label ?? catalogKey,
          );
          intent.resolve({ model });
        } catch (err) {
          intent.reject(err);
        }
      })();

      return true;
    }),
  );

  // ── Handle: get-active-model ────────────────────────────────
  register(
    handleGetActiveModel(intents, (intent) => {
      const manager = getModelManager(ctx);
      const store = manager.store;
      const activeKey = store.activeModelKey;
      if (!activeKey) {
        intent.resolve(undefined);
      } else {
        try {
          const model = store.getLanguageModel(activeKey);
          intent.resolve({ catalogKey: activeKey, model });
        } catch {
          intent.resolve(undefined);
        }
      }
      return true;
    }),
  );

  return cleanup;
}
