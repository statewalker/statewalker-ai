import { newRegistry } from "@repo/shared/registry";
import { DialogView, TabsView, publishDialog } from "@repo/shared-views";
import {
  getActiveModelKey,
  getModelManager,
  setActiveModelKey,
} from "../adapters.js";
import {
  getIntents,
  handleActivateModel,
  handleGetActiveModel,
  handleOpenModelSettings,
} from "../intents.js";
import { resolveActivationSettings } from "../resolve-settings.js";
import { getActiveModelsTabView } from "./active-models.controller.js";
import { getModelsTabView } from "./models.controller.js";
import { getProvidersTabView } from "./providers.controller.js";

export function createModelSettingsController(
  ctx: Record<string, unknown>,
): () => Promise<void> {
  const [register, cleanup] = newRegistry();
  const intents = getIntents(ctx);

  // ── Handle: open-settings ───────────────────────────────────
  register(
    handleOpenModelSettings(intents, (intent) => {
      intent.resolve();

      const providersTab = getProvidersTabView(ctx);
      const modelsTab = getModelsTabView(ctx);
      const activeTab = getActiveModelsTabView(ctx);

      const tabs = new TabsView({
        selectedKey: intent.payload?.tab ?? "providers",
        tabs: [
          { key: "providers", label: "Providers", content: providersTab },
          { key: "models", label: "Models", content: modelsTab },
          { key: "active", label: "Active", content: activeTab },
        ],
      });

      const dialog = new DialogView({
        header: "Model Settings",
        children: [tabs],
        isDismissable: true,
        isOpen: true,
        size: "lg",
        buttons: [
          { label: "Close", variant: "outline" },
        ],
      });

      register(publishDialog(ctx, dialog));
      return true;
    }),
  );

  // ── Handle: activate-model ──────────────────────────────────
  register(
    handleActivateModel(intents, (intent) => {
      const manager = getModelManager(ctx);
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
          const model = manager.getLanguageModel(catalogKey);
          const state = manager.getState(catalogKey);
          setActiveModelKey(ctx, {
            key: catalogKey,
            label: state?.config.label ?? catalogKey,
          });
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
      const active = getActiveModelKey(ctx);
      if (!active.key) {
        intent.resolve(undefined);
      } else {
        try {
          const manager = getModelManager(ctx);
          const model = manager.getLanguageModel(active.key);
          intent.resolve({ catalogKey: active.key, model });
        } catch {
          intent.resolve(undefined);
        }
      }
      return true;
    }),
  );

  return cleanup;
}
