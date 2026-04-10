import { newAdapter } from "@repo/shared/adapters";
import type { ModelPickerView } from "@repo/shared-views/ai-models";
import type { ModelManager } from "@statewalker/ai-provider";

export const [getModelManager, setModelManager] =
  newAdapter<ModelManager>("api:model-manager");

export const [getModelPickerView, setModelPickerView] =
  newAdapter<ModelPickerView>("view:model-picker");

export const [getActiveModelKey, setActiveModelKey] = newAdapter<{
  key: string;
  label: string;
}>("state:active-model", () => ({ key: "", label: "" }));

/** Maps provider name → API key. Set by the host app from stored settings. */
export const [getProviderApiKeys, setProviderApiKeys] = newAdapter<
  Record<string, string>
>("state:provider-api-keys", () => ({}));
