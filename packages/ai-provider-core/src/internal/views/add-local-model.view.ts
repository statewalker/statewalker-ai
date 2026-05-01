import {
  ActionView,
  FlexView,
  PickerView,
  ProgressBarView,
  TextView,
} from "@statewalker/workbench-views";

/**
 * Form for picking and downloading a local model. Pure shell — the
 * picker items are populated by the manager from
 * `runListModels({ runtime: "local" })`. Download progress is
 * forwarded from `ai-provider:activation-progress` broadcasts.
 *
 * Action publishers:
 * - `downloadAction` — submitted with the picker's selected key when
 *   the user clicks Download.
 * - `cancelAction` — submitted when the user cancels an in-flight
 *   download (the manager dispatches `runCancelDownload`).
 * - `closeAction` — submitted when the user closes the form without
 *   downloading.
 */
export class AddLocalModelView extends FlexView {
  readonly modelPicker: PickerView;
  readonly statusText: TextView;
  readonly progress: ProgressBarView;
  readonly downloadAction: ActionView<string>;
  readonly cancelAction: ActionView<string>;
  readonly closeAction: ActionView;

  constructor(options?: { key?: string }) {
    const baseKey = options?.key ?? "ai-config:add-local-model";
    const modelPicker = new PickerView({ key: `${baseKey}:picker` });
    modelPicker.label = "Local model";
    modelPicker.placeholder = "Pick a model to download";
    modelPicker.isRequired = true;

    const statusText = new TextView({ key: `${baseKey}:status`, text: "" });
    const progress = new ProgressBarView({ key: `${baseKey}:progress` });
    progress.value = 0;
    progress.maxValue = 1;
    progress.label = "Download progress";

    const downloadAction = new ActionView<string>({
      key: "ai-config.add-local-model.download",
      label: "Download",
      variant: "primary",
      disabled: true,
    });
    const cancelAction = new ActionView<string>({
      key: "ai-config.add-local-model.cancel",
      label: "Cancel download",
      variant: "danger",
      disabled: true,
    });
    const closeAction = new ActionView({
      key: "ai-config.add-local-model.close",
      label: "Close",
      variant: "secondary",
    });

    super({
      key: baseKey,
      direction: "column",
      gap: "0.5rem",
      children: [modelPicker, statusText, progress],
    });

    this.modelPicker = modelPicker;
    this.statusText = statusText;
    this.progress = progress;
    this.downloadAction = downloadAction;
    this.cancelAction = cancelAction;
    this.closeAction = closeAction;
  }

  setProgress(fraction: number, message?: string): void {
    this.progress.value = Math.max(0, Math.min(1, fraction));
    if (message !== undefined) this.statusText.text = message;
  }

  setIdle(message = ""): void {
    this.progress.value = 0;
    this.statusText.text = message;
    this.cancelAction.disabled = true;
    this.downloadAction.disabled = !this.modelPicker.selectedKey;
  }

  setDownloading(message = "Downloading…"): void {
    this.statusText.text = message;
    this.cancelAction.disabled = false;
    this.downloadAction.disabled = true;
  }
}
