import {
  PROVIDERS_MODEL_PICKER_VIEW_KEY,
  PROVIDERS_SETTINGS_TAB_VIEW_KEY,
} from "@statewalker/ai-providers";
import { coreViewsSlot, type ViewComponent } from "@statewalker/core-react";
import { newRegistry } from "@statewalker/shared-registry";
import { Slots } from "@statewalker/shared-slots";
import { getWorkspace } from "@statewalker/workspace";
import { ComposerModelPicker } from "../internal/composer-model-picker.js";
import { ProviderConfigPanel } from "../internal/provider-config-panel.js";

/**
 * Renderer-fragment init for the providers UI. Pairs with
 * `@statewalker/ai-providers` (logic).
 *
 * Binds `<ProviderConfigPanel>` to the viewKey the providers logic
 * fragment contributes to `settings:tabs`, and binds the
 * `ComposerModelPicker` for the `chat:composer-actions` contribution
 * — same slot-pattern-C shape: logic-side contributes the action
 * descriptor; this renderer binds the React component into the
 * `core:views` slot.
 */
export default function initProvidersReact(
  ctx: Record<string, unknown>,
): () => Promise<void> {
  const workspace = getWorkspace(ctx);
  const slots = workspace.requireAdapter(Slots);

  const [register, cleanup] = newRegistry();
  register(
    slots.register(
      coreViewsSlot,
      PROVIDERS_SETTINGS_TAB_VIEW_KEY,
      ProviderConfigPanel as unknown as ViewComponent,
    ),
  );
  register(
    slots.register(
      coreViewsSlot,
      PROVIDERS_MODEL_PICKER_VIEW_KEY,
      ComposerModelPicker as unknown as ViewComponent,
    ),
  );
  return cleanup;
}
