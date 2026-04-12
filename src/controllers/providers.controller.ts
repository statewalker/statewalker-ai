import { newAdapter } from "@repo/shared/adapters";
import { newRegistry } from "@repo/shared/registry";
import {
  ActionGroupView,
  ActionView,
  BadgeView,
  ButtonView,
  CardView,
  DialogView,
  FlexView,
  getDialogStackView,
  HeadingView,
  InlineAlertView,
  LabeledValueView,
  PickerView,
  publishDialog,
  StatusLightView,
  TextFieldView,
} from "@repo/shared-views";
import {
  PROVIDER_NAMES,
  type ProviderName,
  type RemoteModelConfig,
} from "@statewalker/ai-provider";
import { getModelManager } from "../adapters.js";

export const [getProvidersTabView] = newAdapter<FlexView>(
  "view:providers-tab",
  (ctx) => buildProvidersTab(ctx as Record<string, unknown>),
);

function buildProvidersTab(ctx: Record<string, unknown>): FlexView {
  const [register] = newRegistry();
  const manager = getModelManager(ctx);

  const addProviderAction = new ActionView({
    key: "addProvider",
    label: "+ Add Provider",
    variant: "primary",
  });

  register(
    addProviderAction.onSubmit(() => {
      openAddProviderDialog(ctx, register, manager);
    }),
  );

  const providerCards = PROVIDER_NAMES.map((name) =>
    createProviderCard(name, ctx, register, manager),
  );

  const webgpuStatus = new StatusLightView({
    label: "WebGPU: checking...",
    variant: "neutral",
  });

  const wasmStatus = new StatusLightView({
    label: "WASM: checking...",
    variant: "neutral",
  });

  const storageLabel = new LabeledValueView({ label: "Storage", value: "—" });
  const modelCountLabel = new LabeledValueView({
    label: "Downloaded models",
    value: "0",
  });

  // Detect runtime capabilities
  if (typeof navigator !== "undefined" && "gpu" in navigator) {
    webgpuStatus.label = "WebGPU supported";
    webgpuStatus.variant = "positive";
  } else {
    webgpuStatus.label = "WebGPU not available";
    webgpuStatus.variant = "notice";
  }

  if (typeof WebAssembly !== "undefined") {
    wasmStatus.label = "WASM available";
    wasmStatus.variant = "positive";
  } else {
    wasmStatus.label = "WASM not available";
    wasmStatus.variant = "negative";
  }

  const localRuntimeCard = new CardView({
    header: "Local (In-Browser)",
    children: [
      new FlexView({
        direction: "row",
        gap: "1rem",
        children: [webgpuStatus, wasmStatus],
      }),
      storageLabel,
      modelCountLabel,
    ],
  });

  return new FlexView({
    direction: "column",
    gap: "1rem",
    children: [
      new FlexView({
        direction: "row",
        justifyContent: "between",
        alignItems: "center",
        children: [
          new HeadingView({ text: "Providers", level: 2 }),
          new ButtonView({ action: addProviderAction }),
        ],
      }),
      ...providerCards,
      localRuntimeCard,
    ],
  });
}

function createProviderCard(
  providerName: ProviderName,
  _ctx: Record<string, unknown>,
  register: (cleanup: () => void) => () => void,
  manager: ReturnType<typeof getModelManager>,
): CardView {
  const storedSettings = manager.store.getProviderSettings(providerName);
  const hasKey = Boolean(storedSettings?.apiKey);

  const apiKeyField = new TextFieldView({
    label: "API Key",
    type: "password",
    placeholder: "sk-...",
    isRequired: true,
    value: storedSettings?.apiKey ?? "",
  });

  const statusLight = new StatusLightView({
    label: hasKey ? "Configured" : "Not configured",
    variant: hasKey ? "positive" : "neutral",
  });

  const lastVerified = new LabeledValueView({
    label: "Last verified",
    value: "—",
  });

  const testResult = new InlineAlertView({
    content: "",
    variant: "informative",
  });

  const testAction = new ActionView({
    key: "test",
    label: "Test",
    variant: "secondary",
  });
  const removeAction = new ActionView({
    key: "remove",
    label: "Remove",
    variant: "danger",
  });

  register(
    testAction.onSubmit(async () => {
      testAction.disabled = true;
      testResult.content = "Verifying...";
      testResult.variant = "informative";

      // Find a model for this provider in the catalog
      const firstModelKey = [...manager.store.getStates().entries()].find(
        ([, s]) =>
          s.config.runtime === "remote" &&
          (s.config as RemoteModelConfig).provider === providerName,
      )?.[0];

      if (!firstModelKey) {
        testResult.content = `No models configured for ${providerName}`;
        testResult.variant = "negative";
        testAction.disabled = false;
        return;
      }

      try {
        for await (const p of manager.activate(firstModelKey, {
          settings: { apiKey: apiKeyField.value },
        })) {
          if (p.phase === "error") {
            throw p.error ?? new Error(p.message);
          }
        }
        statusLight.label = "Connected";
        statusLight.variant = "positive";
        testResult.content = "Connection successful";
        testResult.variant = "positive";
      } catch (err) {
        statusLight.label = "Error";
        statusLight.variant = "negative";
        testResult.content = String(err);
        testResult.variant = "negative";
      } finally {
        testAction.disabled = false;
      }
    }),
  );

  register(
    removeAction.onSubmit(() => {
      apiKeyField.value = "";
      statusLight.label = "Not configured";
      statusLight.variant = "neutral";
      testResult.content = "";
    }),
  );

  const modelCount = [...manager.store.getStates().values()].filter(
    (s) =>
      s.config.runtime === "remote" &&
      (s.config as RemoteModelConfig).provider === providerName,
  ).length;

  return new CardView({
    header: new FlexView({
      direction: "row",
      justifyContent: "between",
      alignItems: "center",
      children: [
        new HeadingView({
          text: providerName.charAt(0).toUpperCase() + providerName.slice(1),
          level: 3,
        }),
        statusLight,
      ],
    }),
    children: [apiKeyField, lastVerified, testResult],
    footer: new BadgeView({
      label: `${modelCount} models`,
      variant: "neutral",
      size: "S",
    }),
    actions: [testAction, removeAction],
  });
}

function openAddProviderDialog(
  ctx: Record<string, unknown>,
  register: (cleanup: () => void) => () => void,
  _manager: ReturnType<typeof getModelManager>,
): void {
  const providerTypePicker = new PickerView({
    label: "Provider",
    items: [
      { key: "anthropic", label: "Anthropic" },
      { key: "google", label: "Google" },
      { key: "openai", label: "OpenAI" },
      { key: "openai-compatible", label: "OpenAI-compatible" },
      { key: "lmstudio", label: "LM Studio" },
    ],
    selectedKey: "anthropic",
  });

  const apiKeyField = new TextFieldView({
    label: "API Key",
    type: "password",
    placeholder: "sk-...",
    isRequired: true,
  });

  const baseUrlField = new TextFieldView({
    label: "Base URL",
    placeholder: "http://localhost:1234/v1",
    isDisabled: true,
  });

  const nameField = new TextFieldView({
    label: "Display Name",
    placeholder: "My Server",
    isDisabled: true,
  });

  const testResult = new InlineAlertView({
    content: "",
    variant: "informative",
  });

  const testAndSaveAction = new ActionView({
    key: "testAndSave",
    label: "Test & Save",
    variant: "primary",
  });
  const cancelAction = new ActionView({
    key: "cancel",
    label: "Cancel",
    variant: "neutral",
  });

  const dialog = new DialogView({
    header: "Configure Provider",
    size: "md",
    isDismissable: true,
    isOpen: true,
    children: [
      providerTypePicker,
      apiKeyField,
      baseUrlField,
      nameField,
      testResult,
    ],
    footer: new ActionGroupView({
      children: [cancelAction, testAndSaveAction],
    }),
  });

  register(publishDialog(ctx, dialog));

  const removeFromStack = () => {
    getDialogStackView(ctx).remove(dialog);
  };

  register(
    providerTypePicker.onUpdate(() => {
      const type = providerTypePicker.selectedKey;
      const needsUrl = type === "openai-compatible" || type === "lmstudio";
      const needsKey = type !== "lmstudio";
      apiKeyField.isDisabled = !needsKey;
      baseUrlField.isDisabled = !needsUrl;
      nameField.isDisabled = !needsUrl;
    }),
  );

  register(cancelAction.onSubmit(() => removeFromStack()));

  register(
    testAndSaveAction.onSubmit(async () => {
      testAndSaveAction.disabled = true;
      testResult.content = "Testing connection...";
      testResult.variant = "informative";
      try {
        // For now just resolve — full provider creation logic
        // can be added when custom providers are implemented
        testResult.content = "Saved";
        testResult.variant = "positive";
        removeFromStack();
      } catch (err) {
        testResult.content = String(err);
        testResult.variant = "negative";
      } finally {
        testAndSaveAction.disabled = false;
      }
    }),
  );
}
