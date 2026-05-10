import { newRegistry } from "@statewalker/shared-registry";
import { getWorkspace } from "@statewalker/workspace-api";
import { ViewRegistry } from "@statewalker/core-react";
import {
  PROVIDERS_MODEL_PICKER_VIEW_KEY,
  PROVIDERS_SETTINGS_TAB_VIEW_KEY,
} from "@statewalker/ai-providers";
import { ComposerModelPicker } from "../internal/composer-model-picker.js";
import { ProviderConfigPanel } from "../internal/provider-config-panel.js";

/**
 * Renderer-fragment init for the providers UI. Pairs with
 * `@statewalker/ai-providers` (logic).
 *
 * Wave 4.3 bound `<ProviderConfigPanel>` to the viewKey the
 * providers logic fragment contributes to `settings:tabs`.
 * Wave 7.1 adds the `ComposerModelPicker` binding for the
 * `chat:composer-actions` contribution — same slot-pattern-C
 * shape: providers/ logic contributes the action descriptor,
 * providers-views/ binds the React component here.
 */
export default function initProvidersViews(
  ctx: Record<string, unknown>,
): () => Promise<void> {
  const workspace = getWorkspace(ctx);
  const registry = workspace.requireAdapter(ViewRegistry);

  const [register, cleanup] = newRegistry();
  register(
    registry.register(
      PROVIDERS_SETTINGS_TAB_VIEW_KEY,
      ProviderConfigPanel as unknown as Parameters<typeof registry.register>[1],
    ),
  );
  register(
    registry.register(
      PROVIDERS_MODEL_PICKER_VIEW_KEY,
      ComposerModelPicker as unknown as Parameters<typeof registry.register>[1],
    ),
  );
  return cleanup;
}
