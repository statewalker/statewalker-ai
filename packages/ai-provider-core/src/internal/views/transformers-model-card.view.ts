import {
  ActionView,
  BadgeView,
  ButtonView,
  CardView,
  FlexView,
  HeadingView,
  IconView,
  ProgressBarView,
  SpinnerView,
  TextView,
} from "@statewalker/workbench-views";
import type { VariantStatus } from "./webllm-model-card.view.js";

export interface TransformersModelCardOptions {
  key: string;
  catalogKey: string;
  name: string;
  hfId: string;
  status: VariantStatus;
  progress?: number;
  capabilityBadges?: {
    label: string;
    variant?: "positive" | "negative" | "neutral" | "informative";
  }[];
}

export class TransformersModelCardView extends CardView {
  readonly catalogKey: string;
  readonly icon: IconView;
  readonly heading: HeadingView;
  readonly idText: TextView;
  readonly readyBadge: BadgeView;
  readonly progressBar: ProgressBarView;
  readonly progressText: TextView;
  readonly downloadAction: ActionView;
  readonly downloadButton: ButtonView;
  readonly cancelAction: ActionView;
  readonly cancelButton: ButtonView;
  readonly removeAction: ActionView;
  readonly removeButton: ButtonView;
  readonly spinner: SpinnerView;
  readonly actionRow: FlexView;
  readonly badgesRow: FlexView;

  #status: VariantStatus;

  constructor(options: TransformersModelCardOptions) {
    const icon = new IconView({ key: `${options.key}:icon`, name: "cpu", size: "M" });
    const heading = new HeadingView({
      key: `${options.key}:heading`,
      text: options.name,
      level: 4,
    });
    const idText = new TextView({ key: `${options.key}:id`, text: options.hfId });
    const readyBadge = new BadgeView({
      key: `${options.key}:ready`,
      label: "Ready",
      icon: "check",
      variant: "positive",
    });
    const initialPercent = clampPercent(options.progress ?? 0);
    const progressBar = new ProgressBarView({
      key: `${options.key}:progress`,
      value: initialPercent,
      maxValue: 100,
    });
    const progressText = new TextView({
      key: `${options.key}:progress-text`,
      text: `${Math.round(initialPercent)}%`,
    });
    const downloadAction = new ActionView({
      key: `${options.key}:download`,
      label: "Download",
      icon: "download",
    });
    const downloadButton = new ButtonView({
      key: `${options.key}:download-btn`,
      action: downloadAction,
      size: "S",
    });
    const cancelAction = new ActionView({
      key: `${options.key}:cancel`,
      icon: "x",
      label: "Cancel",
    });
    const cancelButton = new ButtonView({
      key: `${options.key}:cancel-btn`,
      action: cancelAction,
      size: "S",
    });
    const removeAction = new ActionView({
      key: `${options.key}:remove`,
      icon: "trash-2",
      label: "Remove",
    });
    const removeButton = new ButtonView({
      key: `${options.key}:remove-btn`,
      action: removeAction,
      size: "S",
    });
    const spinner = new SpinnerView({ key: `${options.key}:spinner`, size: "S" });
    const badges: BadgeView[] = (options.capabilityBadges ?? []).map(
      (b, i) =>
        new BadgeView({
          key: `${options.key}:cap-${i}`,
          label: b.label,
          variant: b.variant ?? "neutral",
        }),
    );
    const badgesRow = new FlexView({
      key: `${options.key}:badges`,
      direction: "row",
      gap: "0.25rem",
      children: badges,
    });
    const headerRow = new FlexView({
      key: `${options.key}:header`,
      direction: "row",
      gap: "0.5rem",
      children: [icon, heading, idText],
    });
    const actionRow = new FlexView({
      key: `${options.key}:action`,
      direction: "row",
      gap: "0.5rem",
      children: [],
    });
    super({
      key: options.key,
      header: headerRow,
      children: [badgesRow, actionRow],
    });
    this.catalogKey = options.catalogKey;
    this.icon = icon;
    this.heading = heading;
    this.idText = idText;
    this.readyBadge = readyBadge;
    this.progressBar = progressBar;
    this.progressText = progressText;
    this.downloadAction = downloadAction;
    this.downloadButton = downloadButton;
    this.cancelAction = cancelAction;
    this.cancelButton = cancelButton;
    this.removeAction = removeAction;
    this.removeButton = removeButton;
    this.spinner = spinner;
    this.actionRow = actionRow;
    this.badgesRow = badgesRow;
    this.#status = options.status;
    this.applyStatus(options.status);
  }

  get status(): VariantStatus {
    return this.#status;
  }

  applyStatus(status: VariantStatus): void {
    this.#status = status;
    if (status === "not-downloaded") {
      this.actionRow.setChildren([this.downloadButton]);
    } else if (status === "downloading") {
      this.actionRow.setChildren([this.progressBar, this.progressText, this.cancelButton]);
    } else if (status === "downloaded") {
      this.actionRow.setChildren([this.readyBadge, this.removeButton]);
    } else {
      this.actionRow.setChildren([this.spinner]);
    }
  }

  setProgress(percent: number): void {
    const clamped = clampPercent(percent);
    this.progressBar.value = clamped;
    this.progressText.text = `${Math.round(clamped)}%`;
  }
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}
