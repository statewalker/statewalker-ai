import { defineCommand } from "@statewalker/shared-commands";

export interface SelectActiveModelPayload {
  /**
   * Provider id matching a `ProviderDescriptor.id` from the
   * `providers:remote` slot — or `undefined` to clear the active
   * model.
   */
  providerId: string | undefined;
  /** Model id within the chosen provider — or `undefined` to clear. */
  modelId: string | undefined;
}

/**
 * Imperative trigger for changing the active provider+model pointer.
 * The providers fragment's manager handles this by writing through
 * to `ActiveModel`.
 */
export const SelectActiveModelCommand = defineCommand<SelectActiveModelPayload,
  void>("providers:select-active-model", () => {});

/**
 * Open the providers configuration surface. Default handler (when
 * the settings fragment is not loaded) is a no-op; Wave 4.3 wires
 * this to the settings dialog.
 */
export const OpenProviderConfigCommand = defineCommand<void,
  void>("providers:open-config", () => {});
