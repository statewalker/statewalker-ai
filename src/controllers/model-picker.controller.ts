import { newRegistry } from "@repo/shared/registry";
import {
  ModelPickerView,
  type PickerModelItem,
} from "@repo/shared-views/ai-models";
import type { RemoteModelConfig } from "@statewalker/ai-provider";
import { getModelManager, setModelPickerView } from "../adapters.js";
import {
  getIntents,
  handlePickModel,
  runOpenModelSettings,
} from "../intents.js";
import { getModelActivationController } from "./model-activation.controller.js";

export function createModelPickerController(
  ctx: Record<string, unknown>,
): () => Promise<void> {
  const [register, cleanup] = newRegistry();
  const intents = getIntents(ctx);
  const manager = getModelManager(ctx);
  const activation = getModelActivationController(ctx);

  const picker = new ModelPickerView();
  setModelPickerView(ctx, picker);

  function syncItems(): void {
    const items: PickerModelItem[] = [];
    for (const [key, state] of manager.store.getStates()) {
      items.push({
        key,
        label: state.config.label,
        provider:
          state.config.runtime === "remote"
            ? (state.config as RemoteModelConfig).provider
            : state.config.runtime,
        isActive: state.status === "ready",
        isInteractive:
          state.status !== "loading" &&
          !(state.config.runtime === "remote" && state.status === "error"),
        statusReason:
          state.status === "error" ? state.error?.message : undefined,
      });
    }
    picker.items = items;
  }

  // Sync activation state from controller → picker view
  function syncActivationState(): void {
    picker.isActivating = activation.isActivating;
    picker.activationMessage = activation.activationMessage;
  }

  syncItems();
  syncActivationState();

  // Keep picker view in sync with activation controller
  register(activation.onUpdate(syncActivationState));

  // ── Wire selectAction → activate model ─────────────────────
  register(
    picker.selectAction.onSubmit(async () => {
      const catalogKey = picker.selectAction.payload;
      if (!catalogKey) return;

      // If already active, just switch
      const state = manager.store.getState(catalogKey);
      if (state?.status === "ready") {
        picker.currentKey = catalogKey;
        picker.currentLabel = state.config.label;
        manager.store.setActiveModelKey(catalogKey, state.config.label);
        syncItems();
        return;
      }

      try {
        await activation.activate(ctx, manager, catalogKey);
        const updatedState = manager.store.getState(catalogKey);
        picker.currentKey = catalogKey;
        picker.currentLabel = updatedState?.config.label ?? catalogKey;
        manager.store.setActiveModelKey(
          catalogKey,
          updatedState?.config.label ?? "",
        );
        syncItems();
      } catch {
        // Error message is already set by activation controller
      }
    }),
  );

  // ── Wire manageAction → open settings ──────────────────────
  register(
    picker.manageAction.onSubmit(() => {
      runOpenModelSettings(intents, { tab: "models" });
    }),
  );

  // ── Handle pick-model intent ───────────────────────────────
  register(
    handlePickModel(intents, (intent) => {
      picker.isOpen = true;
      const unsub = picker.selectAction.onSubmit(() => {
        const key = picker.selectAction.payload;
        if (key) {
          intent.resolve({ catalogKey: key });
          unsub();
        }
      });
      return true;
    }),
  );

  return cleanup;
}
