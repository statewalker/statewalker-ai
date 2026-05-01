import { ActionView, PickerView } from "@statewalker/workbench-views";
import type { ModelDescriptor, ModelRole } from "../../public/types.js";

/**
 * Inline model picker — used by `runPickModel`. Pure shell exposing a
 * PickerView with model options + a `pickAction` that fires when the
 * user confirms a selection. Optionally scoped to a single role
 * (`reasoning` or `embedding`).
 *
 * Wiring lives in `AiConfigManager`: the manager populates `setModels`
 * with the candidates returned by `runListModels({ role })` and
 * subscribes `pickAction.onSubmit` to resolve the picker intent.
 */
export class ModelPickerView extends PickerView {
  readonly pickAction: ActionView<string>;
  readonly cancelAction: ActionView;

  constructor(options?: { key?: string; role?: ModelRole }) {
    super({ key: options?.key ?? "ai-config:model-picker" });
    this.label = options?.role ? `Pick a ${options.role} model` : "Pick a model";
    this.placeholder = "Search models…";
    this.isRequired = true;
    this.pickAction = new ActionView<string>({
      key: "ai-config.model-picker.pick",
      label: "Use this model",
      variant: "primary",
      disabled: true,
    });
    this.cancelAction = new ActionView({
      key: "ai-config.model-picker.cancel",
      label: "Cancel",
      variant: "secondary",
    });
  }

  /**
   * Replace the picker item set with descriptors. Items get their
   * `key` from `descriptor.catalogKey` and `label` from
   * `descriptor.label` (provider id appended in parens for clarity).
   */
  setModels(models: readonly ModelDescriptor[]): void {
    this.items = models.map((m) => ({
      key: m.catalogKey,
      label: m.providerId ? `${m.label} (${m.providerId})` : m.label,
      section: m.runtime === "local" ? "Local" : "Remote",
    }));
    this.pickAction.disabled = !this.selectedKey;
  }
}
