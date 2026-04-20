import { newRegistry } from "@statewalker/shared-registry";
import {
  ActionGroupView,
  ActionView,
  ButtonView,
  CheckboxView,
  DialogView,
  FlexView,
  getDialogStackView,
  HeadingView,
  InlineAlertView,
  PickerView,
  publishDialog,
  TextFieldView,
  TextView,
} from "@statewalker/shared-views";
import type { ModelManager, ProviderName } from "@statewalker/ai-provider";
import { AddRemoteProviderFormVM } from "../domain/add-remote-provider.form.js";

/**
 * Opens the two-step Add Remote Provider dialog and wires it to the form VM.
 * Returns a cleanup function that tears down the dialog and listeners.
 */
export function openAddRemoteProviderDialog(
  ctx: Record<string, unknown>,
  manager: ModelManager,
): () => void {
  const [register, cleanup] = newRegistry();

  const vm = new AddRemoteProviderFormVM(manager.testConnection.bind(manager));

  // ── Step 1 form fields ──────────────────────────────────────────
  const providerPicker = new PickerView({
    label: "Provider",
    items: [
      { key: "anthropic", label: "Anthropic" },
      { key: "google", label: "Google" },
      { key: "openai", label: "OpenAI" },
      { key: "openai-compatible", label: "OpenAI-compatible" },
    ],
    selectedKey: vm.providerType,
  });
  const apiKeyField = new TextFieldView({
    label: "API Key",
    type: "password",
    placeholder: "sk-...",
    isRequired: true,
    value: vm.apiKey,
  });
  const baseURLField = new TextFieldView({
    label: "Base URL",
    placeholder: "http://localhost:1234/v1",
    isDisabled: true,
    value: vm.baseURL,
  });
  const displayNameField = new TextFieldView({
    label: "Display Name",
    placeholder: "My Server",
    isDisabled: true,
    value: vm.displayName,
  });
  const errorAlert = new InlineAlertView({ content: "", variant: "negative" });
  const connectingHint = new TextView({ text: "" });

  // ── Step 2 (discovered) content ─────────────────────────────────
  const discoveredHeading = new HeadingView({
    text: "Available models",
    level: 3,
  });
  const selectAllAction = new ActionView({
    key: "selectAll",
    label: "Select all",
    variant: "secondary",
  });
  const selectNoneAction = new ActionView({
    key: "selectNone",
    label: "Select none",
    variant: "secondary",
  });
  const checkboxes: CheckboxView[] = [];
  const checkboxContainer = new FlexView({
    direction: "column",
    gap: "0.25rem",
    children: [],
  });

  // ── Footer buttons ──────────────────────────────────────────────
  const addAction = new ActionView({
    key: "add",
    label: "Add",
    variant: "primary",
  });
  const saveAction = new ActionView({
    key: "save",
    label: "Save",
    variant: "primary",
  });
  const cancelAction = new ActionView({
    key: "cancel",
    label: "Cancel",
    variant: "neutral",
  });
  const footer = new ActionGroupView({ children: [cancelAction, addAction] });

  const dialog = new DialogView({
    header: "Add Remote Provider",
    size: "md",
    isDismissable: true,
    isOpen: true,
    children: [
      providerPicker,
      apiKeyField,
      baseURLField,
      displayNameField,
      connectingHint,
    ],
    footer,
  });

  register(publishDialog(ctx, dialog));

  const removeFromStack = () => {
    getDialogStackView(ctx).remove(dialog);
  };

  // ── Wiring: form fields → VM ────────────────────────────────────
  register(
    providerPicker.onUpdate(() => {
      const k = providerPicker.selectedKey as ProviderName | undefined;
      if (k) vm.setProviderType(k);
    }),
  );
  register(apiKeyField.onUpdate(() => vm.setApiKey(apiKeyField.value)));
  register(baseURLField.onUpdate(() => vm.setBaseURL(baseURLField.value)));
  register(
    displayNameField.onUpdate(() => vm.setDisplayName(displayNameField.value)),
  );

  // ── Wiring: actions ─────────────────────────────────────────────
  register(cancelAction.onSubmit(() => removeFromStack()));

  register(
    addAction.onSubmit(async () => {
      await vm.submitAdd();
    }),
  );

  register(
    saveAction.onSubmit(() => {
      const selected = vm.getSelectedDiscovered();
      const instanceId =
        vm.providerType === "openai-compatible"
          ? slugify(vm.displayName)
          : null;
      manager.importDiscoveredModels(
        vm.providerType,
        instanceId,
        selected,
        vm.buildSettings(),
      );
      vm.reset();
      removeFromStack();
    }),
  );

  register(selectAllAction.onSubmit(() => vm.setAllSelected(true)));
  register(selectNoneAction.onSubmit(() => vm.setAllSelected(false)));

  // ── Reactive sync: VM → views ───────────────────────────────────
  const syncViews = () => {
    const kind = vm.providerType;
    const needsUrl = kind === "openai-compatible";
    baseURLField.isDisabled = !needsUrl;
    displayNameField.isDisabled = !needsUrl;
    apiKeyField.isDisabled =
      vm.connectionStatus === "connecting" || kind === "openai-compatible"
        ? vm.connectionStatus === "connecting"
        : false;
    providerPicker.isDisabled = vm.connectionStatus === "connecting";

    // Error alert visibility
    const children = dialog.children;
    const errorPresent = children.includes(errorAlert);
    if (vm.connectionStatus === "error" && vm.connectionError) {
      errorAlert.content = vm.connectionError;
      if (!errorPresent) dialog.addChild(errorAlert);
    } else if (errorPresent) {
      // Remove by rebuilding children without the alert
      dialog.setChildren(children.filter((c) => c !== errorAlert));
    }

    connectingHint.text =
      vm.connectionStatus === "connecting" ? "Connecting…" : "";

    addAction.disabled = !vm.canAdd;
    saveAction.disabled = !vm.canSave;

    // Step-driven content switch
    if (vm.step === "credentials") {
      dialog.header = "Add Remote Provider";
      footer.setChildren([cancelAction, addAction]);
    } else {
      dialog.header = "Select models to import";
      footer.setChildren([cancelAction, saveAction]);

      // Rebuild checkbox list
      checkboxes.length = 0;
      for (const m of vm.discoveredModels) {
        const cb = new CheckboxView({
          key: `discovered:${m.id}`,
          label: m.label,
          isSelected: m.selected,
        });
        register(
          cb.onUpdate(() => {
            if (cb.isSelected !== m.selected) vm.toggleDiscoveredModel(m.id);
          }),
        );
        checkboxes.push(cb);
      }
      checkboxContainer.setChildren(checkboxes);

      dialog.setChildren([
        discoveredHeading,
        new FlexView({
          direction: "row",
          gap: "0.5rem",
          children: [
            new ButtonView({ action: selectAllAction }),
            new ButtonView({ action: selectNoneAction }),
          ],
        }),
        checkboxContainer,
      ]);
    }
  };

  register(vm.onUpdate(syncViews));
  syncViews();

  return cleanup;
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "custom"
  );
}
