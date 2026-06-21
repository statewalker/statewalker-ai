import type { Spec } from "@json-render/core";
import { CONNECTIONS_CATALOG_ID } from "./connections-catalog.js";

/**
 * React-free json-render **spec** for the "Remote Models" settings tab —
 * the connections panel re-targeted onto `AiConfig` + `Secrets`. Per ADR 0002
 * (logic / renderer split) this owns only the opaque `Spec` data + its initial
 * state seed; the schema-typed catalog binding, the React registry, the action
 * handlers, and the `state-bridge` that projects `AiConfig` into the state tree
 * all live in the paired `@statewalker/ai-config.view.react` renderer.
 *
 * ## Layout (prototype variant A — provider-as-tabs)
 *
 *   Stack[v]
 *     ├ "Model connections" heading + subtitle
 *     ├ controlsRow: Tabs (one tab per connection) + "New connection" menu
 *     ├ activeBody (the selected connection): header (name/status/connect/
 *     │   disconnect/remove) · error · settings form (name/key/url/headers) ·
 *     │   discovered-model list with star toggles
 *     ├ emptyState (no connections)
 *     └ confirmDialog (remove-when-keyed gate)
 *
 * ## State tree (projected by the renderer's `state-bridge`)
 *
 *   /persistent/hasConnections : boolean
 *   /persistent/tabs           : Array<{ label; value }>     // Tabs strip
 *   /persistent/active         : null | {                    // the selected tab
 *       id; type; name; connected; models: Array<{ id; label; capabilities; starred }>
 *     }
 *   /ui/activeConnectionId     : string                      // bound to Tabs value
 *   /ui/newConnectionType      : string                      // bound to the New menu
 *   /ui/confirmRemoveOpen      : boolean                     // remove-confirm Dialog
 *   /ui/form                   : { name; apiKey; url; headers; settingsOpen; testing; error }
 *
 * The API key lives **only** at `/ui/form/apiKey` — it is never projected onto
 * `/persistent` and never onto a Connection; `connectConnection` flushes it to
 * `Secrets`. The body is a single active slot (not a `repeat`) so the form binds
 * with static `$bindState` paths under `/ui`, which the json-render Tabs (whose
 * children render once) and the literal-only `eq` comparator both require.
 */
export function makeConnectionsSpec(): Spec {
  return {
    root: "root",
    elements: {
      root: {
        type: "Stack",
        props: {
          direction: "vertical",
          gap: "lg",
          align: "stretch",
          className: "w-full px-4 py-4",
        },
        children: ["title", "subtitle", "controlsRow", "activeBody", "emptyState", "confirmDialog"],
      },

      // ── Header ──────────────────────────────────────────────
      title: { type: "Heading", props: { text: "Model connections", level: "h2" } },
      subtitle: {
        type: "Text",
        props: {
          text: "Connect, test, and pick models from your AI providers.",
          variant: "muted",
        },
      },

      // ── Tab strip + New-connection menu ─────────────────────
      controlsRow: {
        type: "Stack",
        props: { direction: "horizontal", gap: "md", align: "center" },
        children: ["tabs", "newMenu"],
      },
      tabs: {
        type: "Tabs",
        props: {
          tabs: { $state: "/persistent/tabs" },
          value: { $bindState: "/ui/activeConnectionId" },
        },
        visible: { $state: "/persistent/hasConnections" },
      },
      newMenu: {
        type: "DropdownMenu",
        props: {
          label: "+ New connection",
          value: { $bindState: "/ui/newConnectionType" },
          items: [
            { label: "OpenAI", value: "openai" },
            { label: "Anthropic", value: "anthropic" },
            { label: "Google", value: "google" },
            { label: "OpenAI-compatible", value: "openai-compatible" },
          ],
        },
        on: { select: [{ action: "addConnection", params: {} }] },
      },

      // ── Active connection body ──────────────────────────────
      activeBody: {
        type: "Stack",
        props: { direction: "vertical", gap: "lg", align: "stretch" },
        visible: { $state: "/persistent/active" },
        children: ["bodyHeaderRow", "bodyError", "settings", "modelsSection"],
      },
      bodyHeaderRow: {
        type: "Stack",
        props: { direction: "horizontal", gap: "md", align: "center" },
        children: [
          "bodyName",
          "bodyStatus",
          "bodyTestingNote",
          "bodyConnectBtn",
          "bodyDisconnectBtn",
          "bodyRemoveBtn",
        ],
      },
      bodyName: {
        type: "Heading",
        props: { text: { $state: "/persistent/active/name" }, level: "h3" },
      },
      bodyStatus: {
        type: "Badge",
        props: {
          text: {
            $cond: { $state: "/persistent/active/connected", eq: true },
            $then: "Connected",
            $else: "Not connected",
          },
          variant: {
            $cond: { $state: "/persistent/active/connected", eq: true },
            $then: "secondary",
            $else: "outline",
          },
        },
      },
      bodyTestingNote: {
        type: "Text",
        props: { text: "Testing…", variant: "muted" },
        visible: { $state: "/ui/form/testing", eq: true },
      },
      bodyConnectBtn: {
        type: "Button",
        props: {
          label: {
            $cond: { $state: "/persistent/active/connected", eq: true },
            $then: "Re-test",
            $else: "Test & connect",
          },
          variant: "primary",
        },
        on: { press: [{ action: "connectConnection", params: {} }] },
      },
      bodyDisconnectBtn: {
        type: "Button",
        props: { label: "Disconnect", variant: "secondary" },
        visible: { $state: "/persistent/active/connected", eq: true },
        on: { press: [{ action: "disconnectConnection", params: {} }] },
      },
      bodyRemoveBtn: {
        type: "Button",
        props: { label: "Remove", variant: "ghost" },
        on: { press: [{ action: "removeConnection", params: {} }] },
      },
      bodyError: {
        type: "Alert",
        props: { title: "Error", message: { $state: "/ui/form/error" }, type: "error" },
        // Truthy gate — hidden for null / "" , visible once a handler writes a string.
        visible: { $state: "/ui/form/error" },
      },

      // ── Settings form (collapsible) ─────────────────────────
      // Controlled Collapsible: the renderer binds `open` to
      // `/ui/form/settingsOpen` (not stock `defaultOpen`) so
      // `connectConnection` can fold it on a successful connect and the
      // user can re-expand it to edit credentials.
      settings: {
        type: "Collapsible",
        props: { title: "Connection settings", openPath: "/ui/form/settingsOpen" },
        children: ["settingsInner"],
      },
      settingsInner: {
        type: "Stack",
        props: { direction: "vertical", gap: "md", align: "stretch", className: "px-4 py-4" },
        children: ["fName", "fApiKey", "fUrl", "settingsSep", "headersBlock"],
      },
      fName: {
        type: "FieldInput",
        props: {
          label: "Name",
          name: "conn-name",
          type: "text",
          placeholder: "e.g. OpenAI (work)",
          value: { $bindState: "/ui/form/name" },
        },
      },
      fApiKey: {
        type: "FieldInput",
        props: {
          label: "API Key",
          name: "conn-apiKey",
          type: "password",
          placeholder: "sk-…",
          value: { $bindState: "/ui/form/apiKey" },
        },
      },
      fUrl: {
        type: "FieldInput",
        props: {
          label: "URL (required for Anthropic / OpenAI-compatible; optional otherwise)",
          name: "conn-url",
          type: "text",
          placeholder: "https://…",
          value: { $bindState: "/ui/form/url" },
        },
      },
      settingsSep: { type: "Separator", props: { orientation: "horizontal" } },
      headersBlock: {
        type: "Stack",
        props: { direction: "vertical", gap: "sm", align: "stretch" },
        children: ["headersLabel", "headersList", "addHeaderBtn"],
      },
      headersLabel: {
        type: "Text",
        props: {
          text: "Optional HTTP headers forwarded on every request to this connection.",
          variant: "muted",
        },
      },
      headersList: {
        type: "Stack",
        props: { direction: "vertical", gap: "sm", align: "stretch" },
        repeat: { statePath: "/ui/form/headers" },
        children: ["headerRow"],
      },
      headerRow: {
        type: "Stack",
        props: { direction: "horizontal", gap: "sm", align: "center" },
        children: ["headerName", "headerValue", "headerRemove"],
      },
      headerName: {
        type: "Input",
        props: {
          label: "Name",
          name: "headerName",
          type: "text",
          placeholder: "X-Header",
          value: { $bindItem: "name" },
        },
      },
      headerValue: {
        type: "Input",
        props: {
          label: "Value",
          name: "headerValue",
          type: "text",
          placeholder: "value",
          value: { $bindItem: "value" },
        },
      },
      headerRemove: {
        type: "Button",
        props: { label: "×", variant: "secondary" },
        on: { press: [{ action: "removeHeader", params: { index: { $index: true } } }] },
      },
      addHeaderBtn: {
        type: "Button",
        props: { label: "Add header", variant: "secondary" },
        on: { press: [{ action: "addHeader", params: {} }] },
      },

      // ── Discovered-model list ───────────────────────────────
      modelsSection: {
        type: "Stack",
        props: { direction: "vertical", gap: "sm", align: "stretch" },
        visible: { $state: "/persistent/active/connected", eq: true },
        children: ["modelsHeading", "modelsList"],
      },
      modelsHeading: { type: "Heading", props: { text: "Available models", level: "h3" } },
      modelsList: {
        type: "Stack",
        props: { direction: "vertical", gap: "xs", align: "stretch" },
        repeat: { statePath: "/persistent/active/models" },
        children: ["modelRow"],
      },
      modelRow: {
        type: "Stack",
        props: { direction: "horizontal", gap: "md", align: "center" },
        children: ["modelStar", "modelLabel", "modelCaps"],
      },
      modelStar: {
        type: "Switch",
        props: { label: null, name: "starred", checked: { $item: "starred" } },
        on: { change: [{ action: "toggleModelStar", params: { modelId: { $item: "id" } } }] },
      },
      modelLabel: { type: "Text", props: { text: { $item: "label" }, variant: "body" } },
      modelCaps: {
        type: "Text",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: interpreted by json-render's $template expression, not JS
        props: { text: { $template: "${capabilities}" }, variant: "caption" },
      },

      // ── Empty state ─────────────────────────────────────────
      emptyState: {
        type: "Stack",
        props: { direction: "vertical", gap: "md", align: "center", className: "px-4 py-8" },
        visible: { $state: "/persistent/hasConnections", eq: false },
        children: ["emptyHeading", "emptyText"],
      },
      emptyHeading: { type: "Heading", props: { text: "No connections yet", level: "h3" } },
      emptyText: {
        type: "Text",
        props: {
          text: "Add a connection to OpenAI, Anthropic, Google, or an OpenAI-compatible endpoint to get started.",
          variant: "muted",
        },
      },

      // ── Remove-confirm dialog (keyed connections) ───────────
      confirmDialog: {
        type: "Dialog",
        props: {
          title: "Remove connection?",
          description: "This deletes the connection and its saved API key.",
          openPath: "/ui/confirmRemoveOpen",
        },
        children: ["confirmActions"],
      },
      confirmActions: {
        type: "Stack",
        props: { direction: "horizontal", gap: "md", align: "center" },
        children: ["confirmRemoveBtn"],
      },
      confirmRemoveBtn: {
        type: "Button",
        props: { label: "Remove connection", variant: "primary" },
        on: { press: [{ action: "removeConnection", params: { confirmed: true } }] },
      },
    },
  } as Spec;
}

/** Blank settings form — the transient `/ui/form` slot for the active tab. */
function blankForm(): Record<string, unknown> {
  return {
    name: "",
    apiKey: "",
    url: "",
    headers: [] as Array<{ name: string; value: string }>,
    settingsOpen: true,
    testing: false,
    // `null` (not `undefined`) so the Alert's truthy `visible` gate hides it.
    error: null as string | null,
  };
}

/**
 * Initial state seed for the connections `StateStore`. The renderer's
 * `state-bridge` overwrites `/persistent/*` from `AiConfig` on mount and on
 * every update, and swaps `/ui/form` to the selected connection's draft.
 */
export function makeConnectionsInitialState(): Record<string, unknown> {
  return {
    persistent: {
      hasConnections: false,
      tabs: [] as Array<{ label: string; value: string }>,
      active: null,
    },
    ui: {
      activeConnectionId: "",
      newConnectionType: "openai",
      confirmRemoveOpen: false,
      form: blankForm(),
    },
  };
}

/** Re-exported for callers that build the renderer registry against this spec. */
export { CONNECTIONS_CATALOG_ID };
