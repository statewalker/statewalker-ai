import { ActionView, FormView, PickerView, TextFieldView } from "@statewalker/workbench-views";
import type { ProviderName } from "../api/types.js";

const PROVIDER_PICKER_ITEMS: { key: ProviderName; label: string }[] = [
  { key: "anthropic", label: "Anthropic" },
  { key: "openai", label: "OpenAI" },
  { key: "google", label: "Google" },
  { key: "openai-compatible", label: "OpenAI-compatible" },
];

/**
 * Form for adding (or editing) a remote provider. Pure shell — exposes
 * field views (`providerNameField`, `labelField`, `apiKeyField`,
 * `baseURLField`) plus `submitAction` / `cancelAction`. The
 * `submitAction` payload is the assembled `ConfigureProviderPayload`'s
 * `settings` field plus a top-level `providerId`.
 *
 * The form itself is a stateful container — it does not dispatch any
 * intent; the manager subscribes to `submitAction.onSubmit` and runs
 * `runConfigureProvider` with the collected values.
 */
export class AddRemoteProviderView extends FormView {
  readonly providerNameField: PickerView;
  readonly labelField: TextFieldView;
  readonly apiKeyField: TextFieldView;
  readonly baseURLField: TextFieldView;
  readonly submitAction: ActionView;
  readonly cancelAction: ActionView;

  constructor(options?: { key?: string }) {
    const baseKey = options?.key ?? "ai-config:add-remote-provider";
    const providerNameField = new PickerView({ key: `${baseKey}:provider` });
    providerNameField.label = "Provider type";
    providerNameField.items = PROVIDER_PICKER_ITEMS;
    providerNameField.isRequired = true;

    const labelField = new TextFieldView({ key: `${baseKey}:label` });
    labelField.label = "Label";
    labelField.placeholder = "e.g. Anthropic Production";
    labelField.isRequired = true;

    const apiKeyField = new TextFieldView({ key: `${baseKey}:api-key` });
    apiKeyField.label = "API key";
    apiKeyField.placeholder = "sk-…";
    apiKeyField.type = "password";

    const baseURLField = new TextFieldView({ key: `${baseKey}:base-url` });
    baseURLField.label = "Base URL (optional)";
    baseURLField.placeholder = "https://api.example.com/v1";

    const submitAction = new ActionView({
      key: "ai-config.add-remote-provider.submit",
      label: "Save provider",
      variant: "primary",
    });
    const cancelAction = new ActionView({
      key: "ai-config.add-remote-provider.cancel",
      label: "Cancel",
      variant: "secondary",
    });

    super({
      key: baseKey,
      children: [providerNameField, labelField, apiKeyField, baseURLField],
    });

    this.providerNameField = providerNameField;
    this.labelField = labelField;
    this.apiKeyField = apiKeyField;
    this.baseURLField = baseURLField;
    this.submitAction = submitAction;
    this.cancelAction = cancelAction;
  }

  /**
   * Reset all fields to their initial state. Called by the manager
   * after a successful submit or after cancel.
   */
  reset(): void {
    this.providerNameField.selectedKey = undefined;
    this.labelField.value = "";
    this.apiKeyField.value = "";
    this.baseURLField.value = "";
  }
}
