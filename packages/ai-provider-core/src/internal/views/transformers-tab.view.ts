import {
  EmptyView,
  FlexView,
  GridView,
  ScrollAreaView,
  SearchFieldView,
  SwitchView,
} from "@statewalker/workbench-views";

export class TransformersTabView extends FlexView {
  readonly enabledSwitch: SwitchView;
  readonly searchField: SearchFieldView;
  readonly grid: GridView;
  readonly scrollArea: ScrollAreaView;
  readonly empty: EmptyView;

  constructor(options?: { key?: string }) {
    const key = options?.key ?? "ai-config:transformers";
    const enabledSwitch = new SwitchView({
      key: `${key}:enabled`,
      label: "Enable Transformers.js",
    });
    const searchField = new SearchFieldView({
      key: `${key}:search`,
      placeholder: "Search Transformers.js models…",
    });
    const grid = new GridView({
      key: `${key}:grid`,
      columns: "repeat(auto-fill, minmax(280px, 1fr))",
      gap: "0.75rem",
    });
    const scrollArea = new ScrollAreaView({
      key: `${key}:scroll`,
      maxHeight: "600px",
      children: [grid],
    });
    const empty = new EmptyView({
      key: `${key}:empty`,
      icon: "cpu",
      heading: "No models found",
    });
    super({
      key,
      direction: "column",
      gap: "0.75rem",
      children: [enabledSwitch, searchField, scrollArea],
    });
    this.enabledSwitch = enabledSwitch;
    this.searchField = searchField;
    this.grid = grid;
    this.scrollArea = scrollArea;
    this.empty = empty;
  }

  showEmpty(): void {
    this.setChildren([this.enabledSwitch, this.searchField, this.empty]);
  }

  showGrid(): void {
    this.setChildren([this.enabledSwitch, this.searchField, this.scrollArea]);
  }
}
