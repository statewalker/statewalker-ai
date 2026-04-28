import type { ModelManager, ModelStateStore } from "@statewalker/ai-provider";
import { newAdapter } from "@statewalker/shared-adapters";
import type { ModelPickerView } from "../views/model-picker.js";

/** Observable data model — primary adapter for UI controllers. */
export const [getModelStateStore, setModelStateStore] =
  newAdapter<ModelStateStore>("api:model-state-store");

/** Operations controller — used to trigger activation/deactivation. */
export const [getModelManager, setModelManager] = newAdapter<ModelManager>("api:model-manager");

export const [getModelPickerView, setModelPickerView] =
  newAdapter<ModelPickerView>("view:model-picker");
