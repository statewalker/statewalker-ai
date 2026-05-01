import {
  AccordionView,
  EmptyView,
  FlexView,
  SearchFieldView,
  SwitchView,
  ToggleGroupView,
} from "@statewalker/workbench-views";

export class WebllmTabView extends FlexView {
  readonly enabledSwitch: SwitchView;
  readonly searchField: SearchFieldView;
  readonly familyFilter: ToggleGroupView;
  readonly accordion: AccordionView;
  readonly empty: EmptyView;

  constructor(options?: { key?: string }) {
    const key = options?.key ?? "ai-config:webllm";
    const enabledSwitch = new SwitchView({ key: `${key}:enabled`, label: "Enable WebLLM" });
    const searchField = new SearchFieldView({
      key: `${key}:search`,
      placeholder: "Search WebLLM models…",
    });
    const familyFilter = new ToggleGroupView({
      key: `${key}:family-filter`,
      type: "single",
    });
    const accordion = new AccordionView({
      key: `${key}:accordion`,
      allowsMultipleExpanded: true,
    });
    const empty = new EmptyView({
      key: `${key}:empty`,
      icon: "zap",
      heading: "No models found",
    });
    super({
      key,
      direction: "column",
      gap: "0.75rem",
      children: [enabledSwitch, searchField, familyFilter, accordion],
    });
    this.enabledSwitch = enabledSwitch;
    this.searchField = searchField;
    this.familyFilter = familyFilter;
    this.accordion = accordion;
    this.empty = empty;
  }

  showEmpty(): void {
    this.setChildren([this.enabledSwitch, this.searchField, this.familyFilter, this.empty]);
  }

  showAccordion(): void {
    this.setChildren([this.enabledSwitch, this.searchField, this.familyFilter, this.accordion]);
  }
}
