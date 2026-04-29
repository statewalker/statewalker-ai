import { ViewModel } from "@statewalker/workbench-views";

/**
 * Composite root view for the AI configurator panel. Future revisions
 * will compose the seven sub-views from note 04 §6.1 — `provider-list`,
 * `add-remote-provider`, `add-local-model`, `model-list`, `role-summary`,
 * `empty-config`, `model-picker`. For §9 the view is a placeholder
 * sufficient for `mountConfigPanel` to publish a dock panel; the
 * interactive UI is a separate body of work driven by the intent
 * surface (§4-§8) already in place.
 */
export class AiConfigView extends ViewModel {
  constructor() {
    super({ key: "ai-config:view" });
  }
}
