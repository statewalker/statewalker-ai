/** Catalog id for `json:catalogs`. */
export const MODELS_CONFIG_CATALOG_ID = "models-config";

/** ViewKey for the composer's session-model picker. */
export const COMPOSER_PICKER_VIEW_KEY = "models-config:composer-picker";

/** ViewKey for the Settings "Models & Connections" tab body. */
export const MODELS_CONFIG_CONNECTIONS_TAB_VIEW_KEY = "models-config:connections-tab";

/** ViewKey for the Settings "Local Models" tab body. */
export const MODELS_CONFIG_LOCAL_TAB_VIEW_KEY = "models-config:local-tab";

/** Settings tab id used by `OpenSettingsCommand` to deep-link to the
 * Connections tab from `ConfigureModelsCommand`. */
export const MODELS_CONFIG_CONNECTIONS_TAB_ID = "models-config:connections";

/** Settings tab id for the Local Models tab. */
export const MODELS_CONFIG_LOCAL_TAB_ID = "models-config:local";

/** Default base path for transformers.js weight storage. Sits under
 * the workspace's system folder (`<root>/.settings`). */
export const TJS_WEIGHTS_BASE_PATH = "/.settings/models/tjs";
