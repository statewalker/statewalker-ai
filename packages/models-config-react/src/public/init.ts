import { catalogsSlot } from "@statewalker/catalog-registry";
import { coreViewsSlot, type ViewComponent } from "@statewalker/core-react";
import {
  COMPOSER_PICKER_VIEW_KEY,
  MODELS_CONFIG_CATALOG_ID,
  MODELS_CONFIG_OVERLAY_VIEW_KEY,
} from "@statewalker/models-config";
import { newRegistry } from "@statewalker/shared-registry";
import { Slots } from "@statewalker/shared-slots";
import { getWorkspace } from "@statewalker/workspace";
import { buildModelsConfigRegistry } from "../internal/build-react-catalog.js";
import { ComposerStarredPicker } from "../internal/composer-starred-picker.js";
import { ModelsConfigOverlayHost } from "../internal/overlay-host.js";

/**
 * Renderer-fragment init for `models-config-react`. Pairs with
 * `@statewalker/models-config` (logic). Three responsibilities:
 *
 * 1. Register the `models-config` json-render Registry into
 *    `json:catalogs`. The Registry combines shadcn React bindings
 *    with the bespoke `Markdown` primitive.
 * 2. Register `<ModelsConfigOverlayHost>` into `core:views` under
 *    the viewKey contributed by the logic fragment's `dock:overlays`
 *    entry — so the dock-react fragment mounts it alongside MainShell.
 *    The host owns the json-render StateStore, the bridges to
 *    Providers / LocalModels, and the three open-dialog command
 *    listeners.
 * 3. Register `<ComposerStarredPicker>` into `core:views` under the
 *    composer picker viewKey — picked up by the chat composer's
 *    `chat:composer-actions` slot iteration.
 */
export default function initModelsConfigReact(ctx: Record<string, unknown>): () => Promise<void> {
  const workspace = getWorkspace(ctx);
  const slots = workspace.requireAdapter(Slots);

  const [register, cleanup] = newRegistry();

  // The catalog Registry needs action handlers; the overlay host
  // builds its own per-mount Registry with mount-scoped handlers.
  // What we register into `json:catalogs` is a registry built with
  // no-op action handlers — exposed for consumers that just want to
  // look up the catalog metadata (action dispatch goes through the
  // host's controlled store anyway).
  const stubHandlers: Record<string, () => Promise<void>> = {};
  const { registry } = buildModelsConfigRegistry({ actions: stubHandlers });
  register(slots.register(catalogsSlot, MODELS_CONFIG_CATALOG_ID, registry));

  register(
    slots.register(
      coreViewsSlot,
      MODELS_CONFIG_OVERLAY_VIEW_KEY,
      ModelsConfigOverlayHost as unknown as ViewComponent,
    ),
  );

  register(
    slots.register(
      coreViewsSlot,
      COMPOSER_PICKER_VIEW_KEY,
      ComposerStarredPicker as unknown as ViewComponent,
    ),
  );

  return cleanup;
}
