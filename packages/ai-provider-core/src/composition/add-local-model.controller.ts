import type { ModelManager } from "@statewalker/ai-provider";
import { newRegistry } from "@statewalker/shared-registry";
import {
  ActionGroupView,
  ActionView,
  DialogView,
  getDialogStackView,
  InlineAlertView,
  PickerView,
  ProgressBarView,
  publishDialog,
  TextView,
} from "@statewalker/workbench-views";
import { AddLocalModelFormVM } from "../core/add-local-model.form.js";
import { persistDownloadStatus } from "../core/download-status.store.js";

/**
 * Opens the Add Local Model dialog: picker of local models (default Gemma),
 * Download button with progress bar, Cancel-safe abort.
 */
export function openAddLocalModelDialog(
  ctx: Record<string, unknown>,
  manager: ModelManager,
): () => void {
  const [register, cleanup] = newRegistry();

  const vm = AddLocalModelFormVM.fromStates(manager.store.getStates());

  if (vm.catalog.length === 0) {
    const empty = new DialogView({
      header: "No local models available",
      size: "sm",
      isDismissable: true,
      isOpen: true,
      children: [
        new InlineAlertView({
          content: "No local-model catalog is loaded. Ensure WebLLM or llama.cpp is wired.",
          variant: "informative",
        }),
      ],
      footer: new ActionGroupView({
        children: [new ActionView({ key: "close", label: "Close", variant: "neutral" })],
      }),
    });
    register(publishDialog(ctx, empty));
    return cleanup;
  }

  const picker = new PickerView({
    label: "Local model",
    items: vm.catalog.map((e) => ({
      key: e.key,
      label: `${e.label}  (${e.family} · ${e.size})`,
    })),
    selectedKey: vm.selectedKey,
  });

  const progress = new ProgressBarView({
    label: "Download",
    showValueLabel: true,
  });
  const message = new TextView({ text: "" });
  const errorAlert = new InlineAlertView({ content: "", variant: "negative" });

  const downloadAction = new ActionView({
    key: "download",
    label: "Download",
    variant: "primary",
  });
  const cancelAction = new ActionView({
    key: "cancel",
    label: "Cancel",
    variant: "neutral",
  });
  const closeAction = new ActionView({
    key: "close",
    label: "Close",
    variant: "neutral",
  });

  const dialog = new DialogView({
    header: "Add Local Model",
    size: "md",
    isDismissable: true,
    isOpen: true,
    children: [picker, progress, message],
    footer: new ActionGroupView({ children: [cancelAction, downloadAction] }),
  });

  register(publishDialog(ctx, dialog));
  const removeFromStack = () => getDialogStackView(ctx).remove(dialog);

  let abortController: AbortController | undefined;

  // ── Picker → VM ────────────────────────────────────────────────
  register(
    picker.onUpdate(() => {
      const key = picker.selectedKey;
      if (typeof key === "string") vm.setSelectedKey(key);
    }),
  );

  // ── Download action ────────────────────────────────────────────
  register(
    downloadAction.onSubmit(async () => {
      const key = vm.selectedKey;
      if (!key) return;
      vm.beginDownload();
      abortController = new AbortController();
      try {
        for await (const p of manager.download(key, abortController.signal)) {
          vm.applyProgress(p);
        }
        const config = manager.store.catalog[key];
        if (manager.files && config) {
          await persistDownloadStatus(
            manager.files,
            key,
            config.modelId,
            "downloaded",
            undefined,
            config.runtime === "local" ? config.engine : undefined,
          );
        }
        vm.completeDownload();
      } catch (err) {
        vm.failDownload(err instanceof Error ? err.message : String(err));
      } finally {
        abortController = undefined;
      }
    }),
  );

  register(
    cancelAction.onSubmit(() => {
      if (vm.downloadPhase === "downloading") {
        abortController?.abort();
        vm.cancelDownload();
      } else {
        removeFromStack();
      }
    }),
  );

  register(closeAction.onSubmit(() => removeFromStack()));

  // ── VM → views ─────────────────────────────────────────────────
  const syncViews = () => {
    progress.value = vm.progress != null ? Math.round(vm.progress * 100) : undefined;
    progress.label = vm.downloadPhase;
    message.text = vm.message;

    downloadAction.disabled = !vm.canDownload;
    cancelAction.label = vm.downloadPhase === "downloading" ? "Cancel" : "Close";

    const hasError = dialog.children.includes(errorAlert);
    if (vm.downloadPhase === "error" && vm.errorMessage) {
      errorAlert.content = vm.errorMessage;
      if (!hasError) dialog.addChild(errorAlert);
    } else if (hasError) {
      dialog.setChildren(dialog.children.filter((c) => c !== errorAlert));
    }

    if (vm.downloadPhase === "downloaded") {
      removeFromStack();
    }
  };
  register(vm.onUpdate(syncViews));
  syncViews();

  return cleanup;
}
