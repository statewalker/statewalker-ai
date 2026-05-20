import { catalogsSlot } from "@statewalker/catalog-registry";
import { coreViewsSlot, type ViewComponent } from "@statewalker/core-react";
import {
  COMPOSER_PICKER_VIEW_KEY,
  MODELS_CONFIG_CATALOG_ID,
  MODELS_CONFIG_CONNECTIONS_TAB_VIEW_KEY,
  MODELS_CONFIG_LOCAL_TAB_VIEW_KEY,
} from "@statewalker/models-config";
import { newRegistry } from "@statewalker/shared-registry";
import { Slots } from "@statewalker/shared-slots";
import { getWorkspace } from "@statewalker/workspace";
import { buildModelsConfigRegistry } from "../internal/build-react-catalog.js";
import { ComposerSessionModelPicker } from "../internal/composer-session-model-picker.js";
import { ModelsConfigConnectionsTab } from "../internal/connections-tab.js";
import { ModelsConfigLocalTab } from "../internal/local-models-tab.js";

/**
 * Renderer-fragment init for `models-config-react`. Pairs with
 * `@statewalker/models-config` (logic). Responsibilities:
 *
 * 1. Register the `models-config` json-render Registry into
 *    `json:catalogs`. The Registry combines shadcn React bindings
 *    with the bespoke `Markdown` primitive.
 * 2. Register the two Settings-tab host components into `core:views`
 *    under the viewKeys contributed by the logic fragment's
 *    `settings:tabs` entries: Models & Connections + Local Models.
 *    Each host owns its own json-render `StateStore` per mount.
 * 3. Register `<ComposerStarredPicker>` into `core:views` under the
 *    composer picker viewKey.
 *
 * Per ADR 0011, the v4 `dock:overlays` overlay host is retired —
 * the Settings dialog is now the single home for model configuration.
 */
export default function initModelsConfigReact(ctx: Record<string, unknown>): () => Promise<void> {
  const workspace = getWorkspace(ctx);
  const slots = workspace.requireAdapter(Slots);

  const [register, cleanup] = newRegistry();

  // The catalog Registry needs action handlers; the tab hosts build
  // their own per-mount Registry with mount-scoped handlers. What we
  // register into `json:catalogs` is a registry built with no-op
  // action handlers — exposed for consumers that just want to look
  // up the catalog metadata.
  const stubHandlers: Record<string, () => Promise<void>> = {};
  const { registry } = buildModelsConfigRegistry({ actions: stubHandlers });
  register(slots.register(catalogsSlot, MODELS_CONFIG_CATALOG_ID, registry));

  register(
    slots.register(
      coreViewsSlot,
      MODELS_CONFIG_CONNECTIONS_TAB_VIEW_KEY,
      ModelsConfigConnectionsTab as unknown as ViewComponent,
    ),
  );

  register(
    slots.register(
      coreViewsSlot,
      MODELS_CONFIG_LOCAL_TAB_VIEW_KEY,
      ModelsConfigLocalTab as unknown as ViewComponent,
    ),
  );

  register(
    slots.register(
      coreViewsSlot,
      COMPOSER_PICKER_VIEW_KEY,
      ComposerSessionModelPicker as unknown as ViewComponent,
    ),
  );

  return cleanup;
}
