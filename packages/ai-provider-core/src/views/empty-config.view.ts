import { ActionView, EmptyView } from "@statewalker/workbench-views";

/**
 * Empty-state view shown by the AI configurator when no providers are
 * configured and no local models are downloaded. Pure shell — exposes
 * `addRemoteProviderAction` (the "Add provider" CTA) for external
 * wiring. The `addLocalModelAction` is a secondary CTA that opens the
 * local-model picker.
 */
export class EmptyConfigView extends EmptyView {
  readonly addRemoteProviderAction: ActionView;
  readonly addLocalModelAction: ActionView;

  constructor(options?: { key?: string }) {
    const addRemoteProviderAction = new ActionView({
      key: "ai-config.empty.add-remote-provider",
      label: "Add remote provider",
      variant: "primary",
    });
    const addLocalModelAction = new ActionView({
      key: "ai-config.empty.add-local-model",
      label: "Download local model",
      variant: "secondary",
    });
    super({
      key: options?.key ?? "ai-config:empty",
      icon: "sparkles",
      heading: "Configure an AI provider",
      description:
        "Add a remote provider (Anthropic, OpenAI, Google) by entering your API key, or download a local model that runs entirely in the browser.",
      action: addRemoteProviderAction,
    });
    this.addRemoteProviderAction = addRemoteProviderAction;
    this.addLocalModelAction = addLocalModelAction;
  }
}
