import { newRegistry } from "@repo/shared/registry";
import {
  ModelPickerView,
  type PickerModelItem,
} from "@repo/shared-views/ai-models";
import type { RemoteModelConfig } from "@statewalker/ai-provider";
import {
  getModelManager,
  setActiveModelKey,
  setModelPickerView,
} from "../adapters.js";
import {
  getIntents,
  handlePickModel,
  runOpenModelSettings,
} from "../intents.js";
import { resolveActivationSettings } from "../resolve-settings.js";

export function createModelPickerController(
  ctx: Record<string, unknown>,
): () => Promise<void> {
  const [register, cleanup] = newRegistry();
  const intents = getIntents(ctx);
  const manager = getModelManager(ctx);

  const picker = new ModelPickerView();
  setModelPickerView(ctx, picker);

  function syncItems(): void {
    const items: PickerModelItem[] = [];
    for (const [key, state] of manager.getStates()) {
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

  syncItems();

  // ── Wire selectAction → activate model ─────────────────────
  register(
    picker.selectAction.onSubmit(async () => {
      const catalogKey = picker.selectAction.payload;
      if (!catalogKey) return;

      // If already active, just switch
      const state = manager.getState(catalogKey);
      if (state?.status === "ready") {
        picker.currentKey = catalogKey;
        picker.currentLabel = state.config.label;
        setActiveModelKey(ctx, { key: catalogKey, label: state.config.label });
        syncItems();
        return;
      }

      picker.isActivating = true;
      picker.activationMessage = "Activating...";
      try {
        const settings = resolveActivationSettings(ctx, manager, catalogKey);
        for await (const p of manager.activate(catalogKey, { settings })) {
          picker.activationMessage = p.message;
          if (p.phase === "error") {
            throw p.error ?? new Error(p.message);
          }
        }
        const updatedState = manager.getState(catalogKey);
        picker.currentKey = catalogKey;
        picker.currentLabel = updatedState?.config.label ?? catalogKey;
        setActiveModelKey(ctx, {
          key: catalogKey,
          label: updatedState?.config.label ?? "",
        });
        syncItems();
      } catch (err) {
        picker.activationMessage = String(err);
      } finally {
        picker.isActivating = false;
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
