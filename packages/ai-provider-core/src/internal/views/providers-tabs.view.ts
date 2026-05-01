import { TabsView, type ViewModel } from "@statewalker/workbench-views";

export class ProvidersTabsView extends TabsView {
  constructor(options: {
    key?: string;
    remote: ViewModel;
    webllm: ViewModel;
    transformers: ViewModel;
  }) {
    super({
      key: options.key ?? "ai-config:providers-tabs",
      tabs: [
        { key: "remote", label: "Remote", icon: "cloud", content: options.remote },
        { key: "webllm", label: "WebLLM", icon: "zap", content: options.webllm },
        { key: "transformers", label: "Transformers", icon: "cpu", content: options.transformers },
      ],
      selectedKey: "remote",
    });
  }
}
