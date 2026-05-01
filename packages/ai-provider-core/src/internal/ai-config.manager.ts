import { newRegistry } from "@statewalker/shared-registry";
import { DockPanelView, Layout } from "@statewalker/workbench-views";
import type { Workspace } from "@statewalker/workspace-api";
import { AiConfigView } from "./views/ai-config.view.js";

export const AI_CONFIG_PANEL_KEY = "ai-config:main";

export interface AiConfigManagerOptions {
  workspace: Workspace;
}

/**
 * Owns the AI configurator dock panel. Publishes the panel in its
 * constructor (matches the `PanelManager` pattern in `files-panel`).
 *
 * Wiring is filled in across the B2–B8 phases of the
 * `ai-config-views-rewrite` change. The skeleton ensures the package
 * compiles after B1's demolition pass.
 */
export class AiConfigManager {
  readonly view: AiConfigView;
  readonly panelKey: string = AI_CONFIG_PANEL_KEY;

  #cleanup: () => Promise<void>;

  constructor(options: AiConfigManagerOptions) {
    const { workspace } = options;
    const [register, cleanup] = newRegistry();
    this.#cleanup = cleanup;

    this.view = new AiConfigView();
    this.view.showEmpty();

    const layout = workspace.requireAdapter(Layout);
    register(
      layout.publishPanel(
        new DockPanelView({
          key: this.panelKey,
          label: "AI",
          icon: "sparkles",
          area: "right",
          content: this.view,
        }),
      ),
    );
  }

  close(): Promise<void> {
    return this.#cleanup();
  }
}
