import { defineCommand } from "@statewalker/shared-commands";

export interface SelectActiveModelPayload {
  /**
   * Provider id matching a `ProviderDescriptor.id` from the
   * `providers:remote` slot (== `Connection.id`), or the literal
   * `"local"` for a local model — or `undefined` to clear the active
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
export const SelectActiveModelCommand = defineCommand<SelectActiveModelPayload, void>(
  "providers:select-active-model",
  () => {},
);
