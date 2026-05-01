import {
  ActionView,
  ButtonView,
  EmptyView,
  FlexView,
  TabsView,
  type ViewModel,
} from "@statewalker/workbench-views";

export class RemoteProvidersView extends FlexView {
  readonly subTabs: TabsView;
  readonly addProviderAction: ActionView;
  readonly addProviderButton: ButtonView;
  readonly empty: EmptyView;
  readonly tabRow: FlexView;

  constructor(options?: { key?: string }) {
    const key = options?.key ?? "ai-config:remote";
    const subTabs = new TabsView({ key: `${key}:tabs`, tabs: [] });
    const addProviderAction = new ActionView({
      key: `${key}:add-provider`,
      label: "Add provider",
      icon: "plus",
    });
    const addProviderButton = new ButtonView({
      key: `${key}:add-provider-btn`,
      action: addProviderAction,
      size: "S",
    });
    const tabRow = new FlexView({
      key: `${key}:tab-row`,
      direction: "row",
      gap: "0.5rem",
      children: [subTabs, addProviderButton],
    });
    const empty = new EmptyView({
      key: `${key}:empty`,
      icon: "cloud",
      heading: "No remote providers configured",
      description: "Add an OpenAI-compatible provider to get started.",
      action: addProviderAction,
    });
    super({
      key,
      direction: "column",
      gap: "0.75rem",
      children: [empty],
    });
    this.subTabs = subTabs;
    this.addProviderAction = addProviderAction;
    this.addProviderButton = addProviderButton;
    this.empty = empty;
    this.tabRow = tabRow;
  }

  showEmpty(): void {
    this.setChildren([this.empty]);
  }

  showTabs(formContent: ViewModel): void {
    this.setChildren([this.tabRow, formContent]);
  }
}
