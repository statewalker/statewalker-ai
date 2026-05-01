import {
  ActionView,
  ButtonView,
  FlexView,
  HeadingView,
  TabsView,
  TextView,
  type ViewModel,
} from "@statewalker/workbench-views";

/**
 * `RemoteProvidersView` always shows:
 *   1. A section header ("Remote API Providers" + description).
 *   2. A row of provider sub-tabs (predefined `OpenAI`, `Anthropic`, `Google`
 *      plus any custom-added `openai-compatible#…` tabs) with an
 *      `Add Provider` button on the right.
 *   3. A `formSlot` whose single child is the currently-bound
 *      `RemoteProviderFormView` for the selected sub-tab.
 *
 * The manager swaps the form via `setForm(...)`. There is no empty
 * state — the predefined tabs are always present, so the user can pick
 * any of them and configure an API key.
 */
export class RemoteProvidersView extends FlexView {
  readonly sectionHeading: HeadingView;
  readonly sectionDescription: TextView;
  readonly subTabs: TabsView;
  readonly addProviderAction: ActionView;
  readonly addProviderButton: ButtonView;
  readonly tabRow: FlexView;
  readonly formSlot: FlexView;

  constructor(options?: { key?: string }) {
    const key = options?.key ?? "ai-config:remote";
    const sectionHeading = new HeadingView({
      key: `${key}:section-heading`,
      text: "Remote API Providers",
      level: 3,
    });
    const sectionDescription = new TextView({
      key: `${key}:section-description`,
      text: "Connect to cloud-based LLM providers. Select models from each provider to make them available for use.",
    });
    const sectionHeader = new FlexView({
      key: `${key}:section-header`,
      direction: "column",
      gap: "0.25rem",
      children: [sectionHeading, sectionDescription],
    });
    const subTabs = new TabsView({ key: `${key}:tabs`, tabs: [] });
    const addProviderAction = new ActionView({
      key: `${key}:add-provider`,
      label: "Add Provider",
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
      justifyContent: "between",
      children: [subTabs, addProviderButton],
    });
    const formSlot = new FlexView({
      key: `${key}:form-slot`,
      direction: "column",
      gap: "0.5rem",
      children: [],
    });
    super({
      key,
      direction: "column",
      gap: "1rem",
      children: [sectionHeader, tabRow, formSlot],
    });
    this.sectionHeading = sectionHeading;
    this.sectionDescription = sectionDescription;
    this.subTabs = subTabs;
    this.addProviderAction = addProviderAction;
    this.addProviderButton = addProviderButton;
    this.tabRow = tabRow;
    this.formSlot = formSlot;
  }

  setForm(form: ViewModel | undefined): void {
    if (form) this.formSlot.setChildren([form]);
    else this.formSlot.setChildren([]);
  }
}
