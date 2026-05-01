import { FlexView } from "@statewalker/workbench-views";
import { AddLocalModelView } from "./add-local-model.view.js";
import { AddRemoteProviderView } from "./add-remote-provider.view.js";
import { EmptyConfigView } from "./empty-config.view.js";
import { ModelListView } from "./model-list.view.js";
import { ProviderListView } from "./provider-list.view.js";
import { RoleSummaryView } from "./role-summary.view.js";

/**
 * Composite root view for the AI configurator panel. Holds five
 * stable child views (role-summary, provider-list, model-list,
 * add-remote-provider, add-local-model) plus a swappable empty state.
 *
 * Pure shell — `showConfigured()` displays the live state; `showEmpty()`
 * shows the onboarding CTA. Wiring lives in `AiConfigManager`.
 */
export class AiConfigView extends FlexView {
  readonly empty: EmptyConfigView;
  readonly roleSummary: RoleSummaryView;
  readonly providerList: ProviderListView;
  readonly modelList: ModelListView;
  readonly addRemoteProvider: AddRemoteProviderView;
  readonly addLocalModel: AddLocalModelView;

  constructor(options?: { key?: string }) {
    const baseKey = options?.key ?? "ai-config:view";
    const empty = new EmptyConfigView({ key: `${baseKey}:empty` });
    const roleSummary = new RoleSummaryView({ key: `${baseKey}:role-summary` });
    const providerList = new ProviderListView({ key: `${baseKey}:provider-list` });
    const modelList = new ModelListView({ key: `${baseKey}:model-list` });
    const addRemoteProvider = new AddRemoteProviderView({
      key: `${baseKey}:add-remote-provider`,
    });
    const addLocalModel = new AddLocalModelView({ key: `${baseKey}:add-local-model` });

    super({
      key: baseKey,
      direction: "column",
      gap: "1rem",
      children: [empty],
    });

    this.empty = empty;
    this.roleSummary = roleSummary;
    this.providerList = providerList;
    this.modelList = modelList;
    this.addRemoteProvider = addRemoteProvider;
    this.addLocalModel = addLocalModel;
  }

  /** Show the live configurator (role summary + provider list + model list). */
  showConfigured(): void {
    this.setChildren([this.roleSummary, this.providerList, this.modelList]);
  }

  /** Show the onboarding empty state. */
  showEmpty(): void {
    this.setChildren([this.empty]);
  }

  /** Show the add-remote-provider form (modal-style takeover). */
  showAddRemoteProvider(): void {
    this.setChildren([this.addRemoteProvider]);
  }

  /** Show the add-local-model form. */
  showAddLocalModel(): void {
    this.setChildren([this.addLocalModel]);
  }
}
