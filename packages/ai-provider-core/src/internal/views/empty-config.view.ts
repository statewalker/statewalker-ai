import { ActionView, EmptyView } from "@statewalker/workbench-views";

export class EmptyConfigView extends EmptyView {
  readonly openAddProviderAction: ActionView;

  constructor(options?: { key?: string }) {
    const openAddProviderAction = new ActionView({
      key: `${options?.key ?? "ai-config:empty"}:open-add-provider`,
      label: "Add Provider",
      icon: "plus",
      variant: "primary",
    });
    super({
      key: options?.key ?? "ai-config:empty",
      icon: "settings",
      heading: "No AI providers configured",
      description: "Add a provider or download a local model to get started.",
      action: openAddProviderAction,
    });
    this.openAddProviderAction = openAddProviderAction;
  }
}
