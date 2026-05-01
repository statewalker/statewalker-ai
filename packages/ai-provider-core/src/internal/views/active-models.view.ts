import {
  CardView,
  FlexView,
  HeadingView,
  IconView,
  PickerView,
  TextView,
} from "@statewalker/workbench-views";

export class ActiveModelCard extends CardView {
  readonly icon: IconView;
  readonly heading: HeadingView;
  readonly picker: PickerView;
  readonly providerCaption: TextView;

  constructor(options: { key: string; iconName: string; title: string; pickerLabel: string }) {
    const icon = new IconView({ key: `${options.key}:icon`, name: options.iconName, size: "L" });
    const heading = new HeadingView({
      key: `${options.key}:heading`,
      text: options.title,
      level: 4,
    });
    const headerRow = new FlexView({
      key: `${options.key}:header`,
      direction: "row",
      gap: "0.5rem",
      children: [icon, heading],
    });
    const picker = new PickerView({
      key: `${options.key}:picker`,
      label: options.pickerLabel,
      placeholder: "Select a model…",
    });
    const providerCaption = new TextView({
      key: `${options.key}:caption`,
      text: "",
    });
    super({
      key: options.key,
      header: headerRow,
      children: [picker, providerCaption],
    });
    this.icon = icon;
    this.heading = heading;
    this.picker = picker;
    this.providerCaption = providerCaption;
  }
}

export class ActiveModelsView extends FlexView {
  readonly reasoning: ActiveModelCard;
  readonly embedding: ActiveModelCard;

  constructor(options?: { key?: string }) {
    const key = options?.key ?? "ai-config:active-models";
    const reasoning = new ActiveModelCard({
      key: `${key}:reasoning`,
      iconName: "brain",
      title: "Reasoning model",
      pickerLabel: "Reasoning",
    });
    const embedding = new ActiveModelCard({
      key: `${key}:embedding`,
      iconName: "database",
      title: "Embedding model",
      pickerLabel: "Embedding",
    });
    super({
      key,
      direction: "row",
      gap: "1rem",
      children: [reasoning, embedding],
    });
    this.reasoning = reasoning;
    this.embedding = embedding;
  }

  get reasoningPicker(): PickerView {
    return this.reasoning.picker;
  }

  get embeddingPicker(): PickerView {
    return this.embedding.picker;
  }
}
