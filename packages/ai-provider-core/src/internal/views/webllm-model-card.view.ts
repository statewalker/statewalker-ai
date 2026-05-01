import {
  ActionView,
  BadgeView,
  ButtonView,
  FlexView,
  HeadingView,
  IconView,
  ProgressBarView,
  SpinnerView,
  TextView,
} from "@statewalker/workbench-views";

export type VariantStatus = "not-downloaded" | "downloading" | "downloaded" | "removing";

export interface VariantRowOptions {
  catalogKey: string;
  quantization: string;
  status: VariantStatus;
  progress?: number;
}

export class WebllmVariantRow extends FlexView {
  readonly catalogKey: string;
  readonly quantText: TextView;
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

  #status: VariantStatus;

  constructor(options: VariantRowOptions) {
    const key = `webllm:variant:${options.catalogKey}`;
    const quantText = new TextView({ key: `${key}:quant`, text: options.quantization });
    const readyBadge = new BadgeView({
      key: `${key}:ready`,
      label: "Ready",
      icon: "check",
      variant: "positive",
    });
    const progressBar = new ProgressBarView({
      key: `${key}:progress`,
      value: options.progress ?? 0,
      maxValue: 100,
    });
    const progressText = new TextView({
      key: `${key}:progress-text`,
      text: `${Math.round(options.progress ?? 0)}%`,
    });
    const downloadAction = new ActionView({
      key: `${key}:download`,
      label: "Download",
      icon: "download",
    });
    const downloadButton = new ButtonView({
      key: `${key}:download-btn`,
      action: downloadAction,
      size: "S",
    });
    const cancelAction = new ActionView({
      key: `${key}:cancel`,
      icon: "x",
      label: "Cancel",
    });
    const cancelButton = new ButtonView({
      key: `${key}:cancel-btn`,
      action: cancelAction,
      size: "S",
    });
    const removeAction = new ActionView({
      key: `${key}:remove`,
      icon: "trash-2",
      label: "Remove",
    });
    const removeButton = new ButtonView({
      key: `${key}:remove-btn`,
      action: removeAction,
      size: "S",
    });
    const spinner = new SpinnerView({ key: `${key}:spinner`, size: "S" });

    super({
      key,
      direction: "row",
      gap: "0.5rem",
      children: [],
    });

    this.catalogKey = options.catalogKey;
    this.quantText = quantText;
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
    this.#status = options.status;
    this.applyStatus(options.status);
  }

  get status(): VariantStatus {
    return this.#status;
  }

  applyStatus(status: VariantStatus): void {
    this.#status = status;
    if (status === "not-downloaded") {
      this.setChildren([this.quantText, this.downloadButton]);
    } else if (status === "downloading") {
      this.setChildren([this.quantText, this.progressBar, this.progressText, this.cancelButton]);
    } else if (status === "downloaded") {
      this.setChildren([this.quantText, this.readyBadge, this.removeButton]);
    } else {
      this.setChildren([this.quantText, this.spinner]);
    }
  }

  setProgress(percent: number): void {
    this.progressBar.value = percent;
    this.progressText.text = `${Math.round(percent)}%`;
  }
}

export interface WebllmModelCardOptions {
  key: string;
  family: string;
  familyIcon: string;
  name: string;
  variantCount: number;
  capabilityBadges?: {
    label: string;
    variant?: "positive" | "negative" | "neutral" | "informative";
  }[];
  sizeBadgeLabel?: string;
}

/** A FlexView used as the AccordionItem.title (rich title). */
export class WebllmModelCardView extends FlexView {
  readonly icon: IconView;
  readonly heading: HeadingView;
  readonly variantCountText: TextView;
  readonly stateBadge: BadgeView;
  readonly extraBadges: BadgeView[];

  constructor(options: WebllmModelCardOptions) {
    const icon = new IconView({
      key: `${options.key}:icon`,
      name: options.familyIcon,
      size: "M",
    });
    const heading = new HeadingView({
      key: `${options.key}:heading`,
      text: options.name,
      level: 4,
    });
    const stateBadge = new BadgeView({
      key: `${options.key}:state`,
      label: `${options.variantCount} variants`,
      variant: "neutral",
    });
    const variantCountText = new TextView({
      key: `${options.key}:count`,
      text: `${options.variantCount} variants`,
    });
    const extraBadges = (options.capabilityBadges ?? []).map(
      (b, i) =>
        new BadgeView({
          key: `${options.key}:cap-${i}`,
          label: b.label,
          variant: b.variant ?? "neutral",
        }),
    );
    if (options.sizeBadgeLabel) {
      extraBadges.push(
        new BadgeView({
          key: `${options.key}:size`,
          label: options.sizeBadgeLabel,
          variant: "neutral",
        }),
      );
    }
    super({
      key: options.key,
      direction: "row",
      gap: "0.5rem",
      children: [icon, heading, ...extraBadges, stateBadge, variantCountText],
    });
    this.icon = icon;
    this.heading = heading;
    this.variantCountText = variantCountText;
    this.stateBadge = stateBadge;
    this.extraBadges = extraBadges;
  }

  setStateBadge(label: string, variant: "positive" | "informative" | "neutral" = "neutral"): void {
    this.stateBadge.label = label;
    this.stateBadge.variant = variant;
  }
}
