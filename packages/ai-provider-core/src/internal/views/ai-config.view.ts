import { FlexView, HeadingView, IconView, TextView } from "@statewalker/workbench-views";
import { ActiveModelsView } from "./active-models.view.js";
import { EmptyConfigView } from "./empty-config.view.js";
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
      text: "AI providers",
      level: 2,
    });
    const subtitle = new TextView({
      key: `${key}:subtitle`,
      text: "Configure remote and local model providers",
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

export class AiConfigView extends FlexView {
  readonly header: AiConfigHeaderView;
  readonly empty: EmptyConfigView;
  readonly activeModels: ActiveModelsView;
  readonly remoteProviders: RemoteProvidersView;
  readonly webllm: WebllmTabView;
  readonly transformers: TransformersTabView;
  readonly providersTabs: ProvidersTabsView;

  constructor(options?: { key?: string }) {
    const key = options?.key ?? "ai-config:root";
    const header = new AiConfigHeaderView({ key: `${key}:header` });
    const empty = new EmptyConfigView({ key: `${key}:empty` });
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
      children: [empty],
    });
    this.header = header;
    this.empty = empty;
    this.activeModels = activeModels;
    this.remoteProviders = remoteProviders;
    this.webllm = webllm;
    this.transformers = transformers;
    this.providersTabs = providersTabs;
  }

  showEmpty(): void {
    this.setChildren([this.empty]);
  }

  showConfigured(): void {
    this.setChildren([this.header, this.activeModels, this.providersTabs]);
  }
}
