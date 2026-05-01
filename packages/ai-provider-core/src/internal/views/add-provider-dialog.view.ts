import { FlexView, RadioGroupView, TextFieldView } from "@statewalker/workbench-views";

export class AddProviderDialogBodyView extends FlexView {
  readonly typeRadio: RadioGroupView;
  readonly nameField: TextFieldView;
  readonly apiKeyField: TextFieldView;
  readonly endpointField: TextFieldView;

  constructor(options?: { key?: string }) {
    const key = options?.key ?? "ai-config:add-provider-body";
    const typeRadio = new RadioGroupView({
      key: `${key}:type`,
      label: "Provider type",
      orientation: "vertical",
      options: [
        { value: "compatible", label: "OpenAI-compatible" },
        { value: "remote", label: "Standard provider (Coming soon)", disabled: true },
      ],
      value: "compatible",
    });
    const nameField = new TextFieldView({
      key: `${key}:name`,
      label: "Name",
      isRequired: true,
    });
    const apiKeyField = new TextFieldView({
      key: `${key}:api-key`,
      label: "API key",
      type: "password",
    });
    const endpointField = new TextFieldView({
      key: `${key}:endpoint`,
      label: "Endpoint URL",
      type: "url",
    });
    super({
      key,
      direction: "column",
      gap: "0.75rem",
      children: [typeRadio, nameField, apiKeyField, endpointField],
    });
    this.typeRadio = typeRadio;
    this.nameField = nameField;
    this.apiKeyField = apiKeyField;
    this.endpointField = endpointField;
  }

  reset(): void {
    this.typeRadio.value = "compatible";
    this.nameField.value = "";
    this.apiKeyField.value = "";
    this.endpointField.value = "";
  }
}
