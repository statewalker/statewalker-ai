import { newRegistry } from "@repo/shared/registry";
import { DialogView, publishDialog, TabsView } from "@repo/shared-views";
import { getIntents, handleOpenModelSettings } from "../intents.js";
import { getActiveModelsTabView } from "./active-models.controller.js";
import { getModelsTabView } from "./models.controller.js";
import { getProvidersTabView } from "./providers.controller.js";

/**
 * Handles the open-settings intent by composing a three-tab dialog
 * (Providers / Models / Active) and publishing it.
 */
export function createModelSettingsController(
  ctx: Record<string, unknown>,
): () => Promise<void> {
  const [register, cleanup] = newRegistry();
  const intents = getIntents(ctx);

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
        buttons: [{ label: "Close", variant: "outline" }],
      });

      register(publishDialog(ctx, dialog));
      return true;
    }),
  );

  return cleanup;
}
