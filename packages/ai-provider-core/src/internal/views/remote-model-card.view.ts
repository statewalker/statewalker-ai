import {
  ActionView,
  BadgeView,
  ButtonView,
  CardView,
  FlexView,
  HeadingView,
  IconView,
  TextView,
} from "@statewalker/workbench-views";

export interface RemoteModelCardOptions {
  key: string;
  modelId: string;
  label: string;
  selected: boolean;
  capabilityBadges?: {
    label: string;
    variant?: "positive" | "negative" | "neutral" | "informative";
  }[];
  contextWindow?: number;
}

export class RemoteModelCardView extends CardView {
  readonly icon: IconView;
  readonly heading: HeadingView;
  readonly idText: TextView;
  readonly badges: BadgeView[];
  readonly selectedBadge: BadgeView;
  readonly selectAction: ActionView;
  readonly selectButton: ButtonView;
  readonly modelId: string;

  constructor(options: RemoteModelCardOptions) {
    const icon = new IconView({ key: `${options.key}:icon`, name: "cloud", size: "M" });
    const heading = new HeadingView({
      key: `${options.key}:heading`,
      text: options.label,
      level: 4,
    });
    const idText = new TextView({ key: `${options.key}:id`, text: options.modelId });
    const badges: BadgeView[] = (options.capabilityBadges ?? []).map(
      (b, i) =>
        new BadgeView({
          key: `${options.key}:cap-${i}`,
          label: b.label,
          variant: b.variant ?? "neutral",
        }),
    );
    if (options.contextWindow !== undefined) {
      badges.push(
        new BadgeView({
          key: `${options.key}:ctx`,
          label: `${Math.round(options.contextWindow / 1024)}K ctx`,
          variant: "neutral",
        }),
      );
    }
    const selectedBadge = new BadgeView({
      key: `${options.key}:selected`,
      label: "Selected",
      variant: "positive",
      icon: "check",
    });
    const selectAction = new ActionView({
      key: `${options.key}:select`,
      label: options.selected ? "Remove" : "Select",
      icon: options.selected ? "x" : "plus",
    });
    const selectButton = new ButtonView({
      key: `${options.key}:select-btn`,
      action: selectAction,
      size: "S",
    });
    const badgesRow = new FlexView({
      key: `${options.key}:badges`,
      direction: "row",
      gap: "0.25rem",
      children: options.selected ? [...badges, selectedBadge] : badges,
    });
    const headerRow = new FlexView({
      key: `${options.key}:header`,
      direction: "row",
      gap: "0.5rem",
      children: [icon, heading, idText],
    });
    super({
      key: options.key,
      header: headerRow,
      children: [badgesRow, selectButton],
      variant: options.selected ? "highlight" : "normal",
    });
    this.icon = icon;
    this.heading = heading;
    this.idText = idText;
    this.badges = badges;
    this.selectedBadge = selectedBadge;
    this.selectAction = selectAction;
    this.selectButton = selectButton;
    this.modelId = options.modelId;
  }

  setSelected(selected: boolean): void {
    this.variant = selected ? "highlight" : "normal";
    this.selectAction.label = selected ? "Remove" : "Select";
    this.selectAction.icon = selected ? "x" : "plus";
  }
}
