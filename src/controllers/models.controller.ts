import { newAdapter } from "@repo/shared/adapters";
import { newRegistry } from "@repo/shared/registry";
import {
  ActionGroupView,
  ActionView,
  ButtonView,
  ContentPanelView,
  DialogView,
  DividerView,
  FlexView,
  FormView,
  GridView,
  getDialogStackView,
  LabeledValueView,
  type ListBoxItem,
  ListBoxView,
  NumberFieldView,
  PickerView,
  ProgressBarView,
  publishDialog,
  RadioGroupView,
  SliderView,
  StatusLightView,
  TextFieldView,
  TextView,
} from "@repo/shared-views";
import type {
  LocalModelConfig,
  ModelManager,
  RemoteModelConfig,
} from "@statewalker/ai-provider";
import { getModelManager, setActiveModelKey } from "../adapters.js";
import { resolveActivationSettings } from "../resolve-settings.js";

export const [getModelsTabView] = newAdapter<FlexView>(
  "view:models-tab",
  (ctx) => buildModelsTab(ctx as Record<string, unknown>),
);

function buildModelsTab(ctx: Record<string, unknown>): FlexView {
  const [register] = newRegistry();
  const manager = getModelManager(ctx);

  const filterField = new RadioGroupView({
    label: "Filter",
    orientation: "horizontal",
    options: [
      { value: "all", label: "All" },
      { value: "remote", label: "Remote" },
      { value: "local", label: "Local" },
    ],
    value: "all",
  });

  const searchField = new TextFieldView({
    placeholder: "Search models...",
    type: "search",
  });

  const modelList = new ListBoxView({
    selectionMode: "single",
    items: buildModelListItems(manager),
  });

  const detailPanel = new ContentPanelView({
    header: "Select a model",
  });

  const addModelAction = new ActionView({
    key: "addModel",
    label: "+ Add Model",
    variant: "primary",
  });

  register(
    addModelAction.onSubmit(() => {
      openAddModelDialog(ctx, register, manager, modelList);
    }),
  );

  // Wire filter and search
  register(
    filterField.onUpdate(() => {
      modelList.items = buildModelListItems(
        manager,
        filterField.value,
        searchField.value,
      );
    }),
  );
  register(
    searchField.onUpdate(() => {
      modelList.items = buildModelListItems(
        manager,
        filterField.value,
        searchField.value,
      );
    }),
  );

  // Wire list selection → detail panel
  register(
    modelList.onUpdate(() => {
      const selectedKey = [...modelList.selectedKeys][0];
      if (selectedKey) {
        updateDetailPanel(detailPanel, selectedKey, ctx, register, manager);
      }
    }),
  );

  return new FlexView({
    direction: "column",
    gap: "1rem",
    children: [
      new FlexView({
        direction: "row",
        justifyContent: "between",
        alignItems: "center",
        gap: "0.5rem",
        children: [
          filterField,
          searchField,
          new ButtonView({ action: addModelAction }),
        ],
      }),
      new GridView({
        columns: ["minmax(280px, 1fr)", "2fr"],
        gap: "1rem",
        children: [modelList, detailPanel],
      }),
    ],
  });
}

function buildModelListItems(
  manager: ModelManager,
  filter?: string,
  search?: string,
): ListBoxItem[] {
  const items: ListBoxItem[] = [];
  for (const [key, state] of manager.getStates()) {
    const { config } = state;

    if (filter && filter !== "all" && config.runtime !== filter) continue;

    if (search && !config.label.toLowerCase().includes(search.toLowerCase()))
      continue;

    const statusIcon =
      state.status === "ready"
        ? "●"
        : state.status === "downloaded"
          ? "↓"
          : state.status === "error"
            ? "✗"
            : state.status === "loading"
              ? "◌"
              : "○";

    const description =
      config.runtime === "remote"
        ? (config as RemoteModelConfig).provider
        : config.runtime === "local"
          ? `${(config as LocalModelConfig).size} · ${(config as LocalModelConfig).family}`
          : "";

    items.push({
      key,
      label: `${statusIcon} ${config.label}`,
      description,
    });
  }
  return items;
}

function updateDetailPanel(
  panel: ContentPanelView,
  catalogKey: string,
  ctx: Record<string, unknown>,
  register: (cleanup: () => void) => () => void,
  manager: ModelManager,
): void {
  const state = manager.getState(catalogKey);
  if (!state) return;

  const { config } = state;
  panel.header = config.label;

  const metadata: import("@repo/shared-views").ViewModel[] = [
    new LabeledValueView({ label: "Key", value: catalogKey }),
    new LabeledValueView({ label: "Runtime", value: config.runtime }),
    new LabeledValueView({ label: "Model ID", value: config.modelId }),
  ];

  if (config.runtime === "remote") {
    metadata.push(
      new LabeledValueView({
        label: "Provider",
        value: (config as RemoteModelConfig).provider,
      }),
    );
  }
  if (config.runtime === "local") {
    const lc = config as LocalModelConfig;
    metadata.push(
      new LabeledValueView({ label: "Family", value: lc.family }),
      new LabeledValueView({ label: "Quantization", value: lc.dtype }),
      new LabeledValueView({ label: "Size", value: lc.size }),
    );
  }

  const statusLight = new StatusLightView({
    label: state.status,
    variant:
      state.status === "ready"
        ? "positive"
        : state.status === "error"
          ? "negative"
          : state.status === "loading"
            ? "notice"
            : "neutral",
  });

  const paramsForm = new FormView({
    children: [
      new NumberFieldView({
        label: "Max output tokens",
        value: 4096,
        minValue: 1,
        maxValue: 200000,
        step: 256,
      }),
      new SliderView({
        label: "Temperature",
        value: 70,
        minValue: 0,
        maxValue: 200,
        step: 1,
        isFilled: true,
      }),
      ...(config.runtime === "local"
        ? [
            new SliderView({
              label: "Context length",
              value: 2048,
              minValue: 256,
              maxValue: 131072,
              step: 256,
              isFilled: true,
            }),
          ]
        : []),
    ],
  });

  const progressBar = new ProgressBarView({
    label: "Activation",
    showValueLabel: true,
  });
  const progressMessage = new TextView({ text: "" });

  const activateAction = new ActionView({
    key: "activate",
    label:
      state.status === "not-downloaded"
        ? "Download & Activate"
        : state.status === "downloaded"
          ? "Load Model"
          : "Activate",
    variant: "primary",
    disabled: state.status === "ready" || state.status === "loading",
  });

  const deactivateAction = new ActionView({
    key: "deactivate",
    label: "Deactivate",
    variant: "secondary",
    disabled: state.status !== "ready",
  });

  const deleteWeightsAction = new ActionView({
    key: "deleteWeights",
    label: "Delete Weights",
    variant: "danger",
    disabled: config.runtime !== "local" || state.status === "not-downloaded",
  });

  const cancelAction = new ActionView({
    key: "cancel",
    label: "Cancel",
    variant: "neutral",
    disabled: true,
  });

  let abortController: AbortController | undefined;

  register(
    activateAction.onSubmit(async () => {
      activateAction.disabled = true;
      cancelAction.disabled = false;
      abortController = new AbortController();
      try {
        const settings = resolveActivationSettings(ctx, manager, catalogKey);
        for await (const p of manager.activate(catalogKey, {
          settings,
          signal: abortController.signal,
        })) {
          progressBar.value = p.progress != null ? p.progress * 100 : undefined;
          progressBar.label = p.phase;
          progressMessage.text = p.message;
          if (p.error) {
            progressMessage.text = p.error.message;
          }
        }
        setActiveModelKey(ctx, { key: catalogKey, label: config.label });
      } finally {
        activateAction.disabled = false;
        cancelAction.disabled = true;
        abortController = undefined;
        // Refresh
        updateDetailPanel(panel, catalogKey, ctx, register, manager);
      }
    }),
  );

  register(
    cancelAction.onSubmit(() => {
      abortController?.abort();
      manager.cancel(catalogKey);
    }),
  );

  register(
    deactivateAction.onSubmit(() => {
      manager.deactivate(catalogKey);
      updateDetailPanel(panel, catalogKey, ctx, register, manager);
    }),
  );

  register(
    deleteWeightsAction.onSubmit(async () => {
      await manager.deleteLocal(catalogKey);
      updateDetailPanel(panel, catalogKey, ctx, register, manager);
    }),
  );

  const actionGroup = new ActionGroupView({
    children: [
      activateAction,
      deactivateAction,
      deleteWeightsAction,
      cancelAction,
    ],
  });

  panel.setChildren([
    statusLight,
    ...metadata,
    new DividerView({}),
    paramsForm,
    progressBar,
    progressMessage,
    new DividerView({}),
    actionGroup,
  ]);
}

function openAddModelDialog(
  ctx: Record<string, unknown>,
  register: (cleanup: () => void) => () => void,
  _manager: ModelManager,
  modelList: ListBoxView,
): void {
  const runtimeField = new RadioGroupView({
    label: "Runtime",
    orientation: "horizontal",
    options: [
      { value: "remote", label: "Remote API" },
      { value: "local", label: "Local (in-browser)" },
    ],
    value: "remote",
  });

  const providerField = new PickerView({
    label: "Provider",
    items: [
      { key: "anthropic", label: "Anthropic" },
      { key: "google", label: "Google" },
      { key: "openai", label: "OpenAI" },
    ],
    selectedKey: "anthropic",
  });

  const modelIdField = new TextFieldView({
    label: "Model ID",
    placeholder: "claude-sonnet-4-20250514",
    isRequired: true,
  });

  const labelField = new TextFieldView({
    label: "Display Name",
    placeholder: "Claude Sonnet",
    isRequired: true,
  });

  const familyField = new TextFieldView({
    label: "Family",
    placeholder: "e.g. Qwen 3.5",
    isDisabled: true,
  });
  const quantField = new PickerView({
    label: "Quantization",
    items: [
      { key: "q4f16", label: "q4f16 (recommended)" },
      { key: "q4", label: "q4" },
      { key: "fp16", label: "fp16 (full)" },
    ],
    selectedKey: "q4f16",
    isDisabled: true,
  });
  const sizeField = new TextFieldView({
    label: "Download Size",
    placeholder: "1.2 GB",
    isDisabled: true,
  });

  const addAction = new ActionView({
    key: "add",
    label: "Add to Catalog",
    variant: "primary",
  });
  const cancelAction = new ActionView({
    key: "cancel",
    label: "Cancel",
    variant: "neutral",
  });

  const dialog = new DialogView({
    header: "Add Model",
    size: "M",
    isDismissable: true,
    isOpen: true,
    children: [
      runtimeField,
      providerField,
      modelIdField,
      labelField,
      familyField,
      quantField,
      sizeField,
    ],
    footer: new ActionGroupView({ children: [cancelAction, addAction] }),
  });

  register(publishDialog(ctx, dialog));

  const removeFromStack = () => {
    getDialogStackView(ctx).remove(dialog);
  };

  register(
    runtimeField.onUpdate(() => {
      const isRemote = runtimeField.value === "remote";
      providerField.isDisabled = !isRemote;
      familyField.isDisabled = isRemote;
      quantField.isDisabled = isRemote;
      sizeField.isDisabled = isRemote;
    }),
  );

  register(cancelAction.onSubmit(() => removeFromStack()));

  register(
    addAction.onSubmit(() => {
      // Refresh list (catalog extension would happen here via mergeCatalogs)
      modelList.items = buildModelListItems(_manager);
      removeFromStack();
    }),
  );
}
