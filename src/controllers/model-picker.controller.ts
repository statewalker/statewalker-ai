import { newRegistry } from "@statewalker/shared-registry";
import {
  ModelPickerView,
  type PickerModelItem,
} from "@repo/shared-views/ai-models";
import type { RemoteModelConfig } from "@statewalker/ai-provider";
import { getModelManager, setModelPickerView } from "../adapters.js";
import { getIntents, runOpenModelSettings } from "../intents.js";
import { getModelActivationController } from "./model-activation.controller.js";
import { getModelListView } from "./model-settings.controller.js";

/**
 * Owns the shared `ModelPickerView` visible in the chat header. Drives
 * its `mode` from `ModelListView.activeReasoningKeys`:
 *   0 → "Configure model…" button; clicks open the settings panel.
 *   1 → static label (no dropdown).
 *   ≥ 2 → dropdown listing each active reasoning model; selection
 *         updates `store.activeModelKey` for the next agent turn.
 */
export function createModelPickerController(
  ctx: Record<string, unknown>,
): () => Promise<void> {
  const [register, cleanup] = newRegistry();
  const intents = getIntents(ctx);
  const manager = getModelManager(ctx);
  const activation = getModelActivationController(ctx);
  const listView = getModelListView(ctx);

  const picker = new ModelPickerView();
  setModelPickerView(ctx, picker);

  function sync(): void {
    const activeKeys = [...listView.activeReasoningKeys];
    const items: PickerModelItem[] = activeKeys.map((key) => {
      const state = manager.store.getState(key);
      const config = state?.config;
      const provider =
        config?.runtime === "remote"
          ? (config as RemoteModelConfig).provider
          : (config?.runtime ?? "");
      return {
        key,
        label: config?.label ?? key,
        provider,
        isActive: true,
        isInteractive: true,
      };
    });
    picker.items = items;

    picker.mode =
      activeKeys.length === 0
        ? "none"
        : activeKeys.length === 1
          ? "single"
          : "multi";

    // Keep the visible label/key in sync with the store's active key, or
    // default to the first active entry when nothing is selected.
    const current = manager.store.activeModelKey;
    if (current && activeKeys.includes(current)) {
      picker.currentKey = current;
      picker.currentLabel = manager.store.getState(current)?.config.label ?? "";
    } else if (activeKeys.length > 0) {
      const first = activeKeys[0];
      if (typeof first === "string") {
        const label = manager.store.getState(first)?.config.label ?? first;
        picker.currentKey = first;
        picker.currentLabel = label;
        manager.store.setActiveModelKey(first, label);
      }
    } else {
      picker.currentKey = "";
      picker.currentLabel = "";
    }
  }

  function syncActivationState(): void {
    picker.isActivating = activation.isActivating;
    picker.activationMessage = activation.activationMessage;
  }

  register(listView.onUpdate(sync));
  register(activation.onUpdate(syncActivationState));
  sync();
  syncActivationState();

  // Select-action: switch the current active model to the picked entry.
  register(
    picker.selectAction.onSubmit(() => {
      const key = picker.selectAction.payload;
      if (!key) return;
      const state = manager.store.getState(key);
      if (state?.status !== "ready") return;
      manager.store.setActiveModelKey(key, state.config.label);
      sync();
    }),
  );

  // Manage-action: open the settings panel.
  register(
    picker.manageAction.onSubmit(() => {
      runOpenModelSettings(intents, undefined).catch(console.error);
    }),
  );

  return cleanup;
}
