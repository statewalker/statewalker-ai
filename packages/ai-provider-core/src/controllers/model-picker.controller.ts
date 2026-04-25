import type { RemoteModelConfig } from "@statewalker/ai-provider";
import { newRegistry } from "@statewalker/shared-registry";
import { getModelManager, setModelPickerView } from "../adapters.js";
import { getIntents, runOpenModelSettings } from "../intents.js";
import { ModelPickerView, type PickerModelItem } from "../views/model-picker.js";
import { getModelActivationController } from "./model-activation.controller.js";
import { getModelListView } from "./model-settings.controller.js";

/**
 * Owns the shared `ModelPickerView` visible in the chat header. Drives
 * its mode from `ModelListView.activeReasoningKeys`:
 *   0 → "Configure model…" button (composed `ButtonView`).
 *   1 → static label (composed `TextView`).
 *   ≥ 2 → dropdown (composed `MenuTriggerView`); selection updates
 *         `store.activeModelKey` for the next agent turn.
 */
export function createModelPickerController(ctx: Record<string, unknown>): () => Promise<void> {
  const [register, cleanup] = newRegistry();
  const intents = getIntents(ctx);
  const manager = getModelManager(ctx);
  const activation = getModelActivationController(ctx);
  const listView = getModelListView(ctx);

  const picker = new ModelPickerView();
  setModelPickerView(ctx, picker);

  function buildItems(activeKeys: string[]): PickerModelItem[] {
    return activeKeys.map((key) => {
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
  }

  function resolveCurrent(activeKeys: string[]): { key: string; label: string } {
    const current = manager.store.activeModelKey;
    if (current && activeKeys.includes(current)) {
      const label = manager.store.getState(current)?.config.label ?? "";
      return { key: current, label };
    }
    if (activeKeys.length > 0) {
      const first = activeKeys[0];
      if (typeof first === "string") {
        const label = manager.store.getState(first)?.config.label ?? first;
        manager.store.setActiveModelKey(first, label);
        return { key: first, label };
      }
    }
    return { key: "", label: "" };
  }

  function sync(): void {
    const activeKeys = [...listView.activeReasoningKeys];
    const items = buildItems(activeKeys);
    const { key, label } = resolveCurrent(activeKeys);

    if (activeKeys.length === 0) {
      picker.setNoneMode();
    } else if (activeKeys.length === 1) {
      picker.setSingleMode(items, key, label);
    } else {
      picker.setMultiMode(items, key, label);
    }
  }

  function syncActivation(): void {
    picker.setActivationState(activation.isActivating, activation.activationMessage);
  }

  register(listView.onUpdate(sync));
  register(activation.onUpdate(syncActivation));
  sync();
  syncActivation();

  // Select-action: switch the active model on the picked entry.
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

  // Configure / Manage: open the settings panel.
  const openSettings = () => runOpenModelSettings(intents, undefined).catch(console.error);
  register(picker.configureAction.onSubmit(openSettings));
  register(picker.manageAction.onSubmit(openSettings));

  return cleanup;
}
