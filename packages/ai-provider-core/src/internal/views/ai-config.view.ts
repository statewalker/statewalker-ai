import { FlexView, HeadingView, IconView, TextView } from "@statewalker/workbench-views";
import { ActiveModelsView } from "./active-models.view.js";
import { ProvidersTabsView } from "./providers-tabs.view.js";
import { RemoteProvidersView } from "./remote-providers.view.js";
import { TransformersTabView } from "./transformers-tab.view.js";
import { WebllmTabView } from "./webllm-tab.view.js";

export class AiConfigHeaderView extends FlexView {
  readonly icon: IconView;
  readonly heading: HeadingView;
  readonly subtitle: TextView;

  constructor(options?: { key?: string }) {
    const key = options?.key ?? "ai-config:header";
    const icon = new IconView({ key: `${key}:icon`, name: "settings", size: "L" });
    const heading = new HeadingView({
      key: `${key}:heading`,
      text: "LLM Configuration",
      level: 2,
    });
    const subtitle = new TextView({
      key: `${key}:subtitle`,
      text: "Configure AI models for reasoning and embeddings",
    });
    const titleStack = new FlexView({
      key: `${key}:title`,
      direction: "column",
      gap: "0.125rem",
      children: [heading, subtitle],
    });
    super({
      key,
      direction: "row",
      gap: "0.75rem",
      children: [icon, titleStack],
    });
    this.icon = icon;
    this.heading = heading;
    this.subtitle = subtitle;
  }
}

/**
 * Root view of the AI configurator. Always shows
 * `[header, activeModels, providersTabs]`. The legacy "no providers
 * configured" empty state is gone — predefined remote-provider tabs
 * (OpenAI / Anthropic / Google) are always present, so the user can
 * pick any of them and configure an API key without prior setup.
 */
export class AiConfigView extends FlexView {
  readonly header: AiConfigHeaderView;
  readonly activeModels: ActiveModelsView;
  readonly remoteProviders: RemoteProvidersView;
  readonly webllm: WebllmTabView;
  readonly transformers: TransformersTabView;
  readonly providersTabs: ProvidersTabsView;

  constructor(options?: { key?: string }) {
    const key = options?.key ?? "ai-config:root";
    const header = new AiConfigHeaderView({ key: `${key}:header` });
    const activeModels = new ActiveModelsView({ key: `${key}:active-models` });
    const remoteProviders = new RemoteProvidersView({ key: `${key}:remote` });
    const webllm = new WebllmTabView({ key: `${key}:webllm` });
    const transformers = new TransformersTabView({ key: `${key}:transformers` });
    const providersTabs = new ProvidersTabsView({
      key: `${key}:providers-tabs`,
      remote: remoteProviders,
      webllm,
      transformers,
    });
    super({
      key,
      direction: "column",
      gap: "1.5rem",
      padding: "1em",
      children: [header, activeModels, providersTabs],
    });
    this.header = header;
    this.activeModels = activeModels;
    this.remoteProviders = remoteProviders;
    this.webllm = webllm;
    this.transformers = transformers;
    this.providersTabs = providersTabs;
  }
}
