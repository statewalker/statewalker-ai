/**
 * React-free **catalog contract** for the connections panel: the catalog id, the
 * component vocabulary the spec is allowed to reference, and the action names the
 * spec dispatches. Per ADR 0002 the schema-typed `defineCatalog(schema, …)`
 * binding (which needs `@json-render/react`'s `schema`) and the React component /
 * action handler implementations live in `@statewalker/ai-config.view.react`;
 * this module is the single source of truth those bindings — and the spec
 * validation test — agree on.
 */

/** Catalog id registered into `render.core`'s `json:catalogs` slot. */
export const CONNECTIONS_CATALOG_ID = "ai-config:connections";

/**
 * Component types `makeConnectionsSpec()` may use: the `@json-render/shadcn`
 * stock primitives this panel binds, plus the bespoke `FieldInput` (autofill
 * suppression + show/hide on the API-key field). The renderer registers exactly
 * these into the registry; the validation test asserts the spec references no
 * `type` outside this set.
 */
export const CONNECTIONS_COMPONENTS = [
  "Stack",
  "Heading",
  "Text",
  "Badge",
  "Button",
  "Alert",
  "Separator",
  "Tabs",
  "DropdownMenu",
  "Collapsible",
  "Dialog",
  "Input",
  "Switch",
  "FieldInput",
] as const;

/**
 * The connections action vocabulary, bound to `AiConfig` + `Secrets` by the
 * renderer's `action-handlers`. The validation test asserts the spec dispatches
 * no `action` outside this set.
 */
export const CONNECTIONS_ACTIONS = [
  "addConnection",
  "connectConnection",
  "disconnectConnection",
  "removeConnection",
  "toggleModelStar",
  "addHeader",
  "removeHeader",
] as const;

export type ConnectionsComponent = (typeof CONNECTIONS_COMPONENTS)[number];
export type ConnectionsAction = (typeof CONNECTIONS_ACTIONS)[number];
