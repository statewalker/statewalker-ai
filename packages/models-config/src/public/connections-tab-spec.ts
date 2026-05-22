import type { Spec } from "@json-render/core";
import type { ConnectionType } from "@statewalker/ai-providers";

/**
 * json-render spec for the Settings dialog's "Models & Connections"
 * tab body. Structurally:
 *
 *   Stack[v]
 *     ├ infoBanner ("To chat you need a chat-capable model…")
 *     ├ Tabs (4 sub-tabs, one per ConnectionType)
 *     │   ├ google body  ──┐
 *     │   ├ openai body    │ each body = Stack[v]
 *     │   ├ anthropic body │   - Connection list (filtered by type)
 *     │   └ openai-compat ─┘   - form (name / apiKey / url? / headers)
 *     │                        - error block
 *     │                        - Connect button (form mode)
 *     │                        - per-Connection model list (when row selected)
 *
 * Note: this is the v5 tab body. There is no surrounding Dialog —
 * the Settings dialog provides that wrapping. The single-spec /
 * three-Dialog factory from the v4 draft is retired.
 */
const CONNECTION_TYPES: ConnectionType[] = ["google", "openai", "anthropic", "openai-compatible"];

const TYPE_LABEL: Record<ConnectionType, string> = {
  google: "Google",
  openai: "OpenAI",
  anthropic: "Anthropic",
  "openai-compatible": "OpenAI-compatible",
};

function tabBodyElements(type: ConnectionType): Record<string, unknown> {
  const urlRequired = type === "anthropic" || type === "openai-compatible";
  const urlLabel = urlRequired ? "URL (required)" : "URL (optional — proxy override)";
  const urlPlaceholder =
    type === "anthropic"
      ? "https://your-anthropic-proxy.example.com (CORS-blocked direct calls are not supported)"
      : type === "openai-compatible"
        ? "https://your-endpoint.example.com/v1"
        : "https://… (leave blank to use the default endpoint)";
  return {
    [`${type}_body`]: {
      type: "Stack",
      props: {
        direction: "vertical",
        gap: "lg",
        // Obsidian-style internal padding around the tab body.
        className: "px-4 py-4",
      },
      children: [`${type}_connectionsList`, `${type}_formCard`, `${type}_perConnModels`],
    },
    [`${type}_connectionsList`]: {
      type: "Stack",
      props: { direction: "vertical", gap: "sm" },
      children: [`${type}_connectionRow`],
    },
    [`${type}_connectionRow`]: {
      type: "Stack",
      props: { direction: "horizontal", gap: "md", align: "center" },
      repeat: { statePath: `/persistent/connectionsByType/${type}` },
      children: [
        `${type}_connectionRowName`,
        `${type}_connectionRowStatus`,
        `${type}_connectionRowConnectBtn`,
        `${type}_connectionRowCheckBtn`,
        `${type}_connectionRowDisconnectBtn`,
      ],
    },
    [`${type}_connectionRowName`]: {
      type: "Text",
      props: { text: { $item: "name" }, variant: "body" },
    },
    [`${type}_connectionRowStatus`]: {
      type: "Badge",
      props: {
        text: {
          $cond: { $item: "connected", eq: true },
          $then: "Connected",
          $else: "Disconnected",
        },
        variant: {
          $cond: { $item: "connected", eq: true },
          $then: "secondary",
          $else: "outline",
        },
      },
    },
    [`${type}_connectionRowConnectBtn`]: {
      type: "Button",
      props: { label: "Connect", variant: "primary" },
      visible: { $item: "connected", eq: false },
      on: {
        press: [
          {
            action: "connectConnection",
            params: { connectionId: { $item: "id" } },
          },
        ],
      },
    },
    [`${type}_connectionRowCheckBtn`]: {
      type: "Button",
      props: { label: "Check Connection", variant: "secondary" },
      visible: { $item: "connected", eq: true },
      on: {
        press: [
          {
            action: "checkConnection",
            params: { connectionId: { $item: "id" } },
          },
        ],
      },
    },
    [`${type}_connectionRowDisconnectBtn`]: {
      type: "Button",
      props: { label: "Disconnect", variant: "secondary" },
      visible: { $item: "connected", eq: true },
      on: {
        press: [
          {
            action: "disconnectConnection",
            params: { connectionId: { $item: "id" } },
          },
        ],
      },
    },

    // ── Add new Connection form (per-tab) ────────────────────
    // Obsidian-style: section heading + muted description, separator,
    // form fields, separator before the optional Headers section,
    // error + primary button at the bottom. No Card chrome — padding
    // comes from the outer body Stack className.
    [`${type}_formCard`]: {
      type: "Stack",
      props: { direction: "vertical", gap: "md" },
      children: [
        `${type}_formHeading`,
        `${type}_formDescription`,
        `${type}_formSep1`,
        `${type}_formName`,
        `${type}_formApiKey`,
        `${type}_formUrl`,
        `${type}_formSep2`,
        `${type}_formHeadersHeading`,
        `${type}_formHeadersLabel`,
        `${type}_formHeadersList`,
        `${type}_formAddHeader`,
        `${type}_formError`,
        `${type}_formConnect`,
      ],
    },
    [`${type}_formHeading`]: {
      type: "Heading",
      props: { text: `Add ${TYPE_LABEL[type]} connection`, level: "h3" },
    },
    [`${type}_formDescription`]: {
      type: "Text",
      props: {
        text: `Enter your ${TYPE_LABEL[type]} API key to connect and discover available models.`,
        variant: "muted",
      },
    },
    [`${type}_formSep1`]: {
      type: "Separator",
      props: { orientation: "horizontal" },
    },
    [`${type}_formSep2`]: {
      type: "Separator",
      props: { orientation: "horizontal" },
    },
    [`${type}_formHeadersHeading`]: {
      type: "Heading",
      props: { text: "Headers", level: "h4" },
    },
    [`${type}_formName`]: {
      type: "Input",
      props: {
        label: "Name",
        name: "name",
        type: "text",
        placeholder: `e.g. ${TYPE_LABEL[type]} (work)`,
        value: { $bindState: `/ui/connectionForms/${type}/name` },
      },
    },
    [`${type}_formApiKey`]: {
      type: "Input",
      props: {
        label: "API Key",
        name: "apiKey",
        type: "password",
        placeholder: "sk-…",
        value: { $bindState: `/ui/connectionForms/${type}/apiKey` },
      },
    },
    [`${type}_formUrl`]: {
      type: "Input",
      props: {
        label: urlLabel,
        name: "url",
        type: "text",
        placeholder: urlPlaceholder,
        value: { $bindState: `/ui/connectionForms/${type}/url` },
      },
    },
    [`${type}_formHeadersLabel`]: {
      type: "Text",
      props: {
        text: "Optional HTTP headers forwarded on every request to this connection.",
        variant: "muted",
      },
    },
    [`${type}_formHeadersList`]: {
      type: "Stack",
      props: { direction: "vertical", gap: "sm" },
      children: [`${type}_formHeaderRow`],
    },
    [`${type}_formHeaderRow`]: {
      type: "Stack",
      props: { direction: "horizontal", gap: "sm", align: "center" },
      repeat: { statePath: `/ui/connectionForms/${type}/headers` },
      children: [`${type}_formHeaderName`, `${type}_formHeaderValue`, `${type}_formHeaderRemove`],
    },
    [`${type}_formHeaderName`]: {
      type: "Input",
      props: {
        label: "Name",
        name: "headerName",
        type: "text",
        placeholder: "X-Header",
        value: { $bindItem: "name" },
      },
    },
    [`${type}_formHeaderValue`]: {
      type: "Input",
      props: {
        label: "Value",
        name: "headerValue",
        type: "text",
        placeholder: "value",
        value: { $bindItem: "value" },
      },
    },
    [`${type}_formHeaderRemove`]: {
      type: "Button",
      props: { label: "×", variant: "secondary" },
      on: {
        press: [{ action: "removeHeader", params: { index: { $index: true } } }],
      },
    },
    [`${type}_formAddHeader`]: {
      type: "Button",
      props: { label: "Add header", variant: "secondary" },
      on: { press: [{ action: "addHeader", params: {} }] },
    },
    [`${type}_formError`]: {
      type: "Alert",
      props: {
        title: "Error",
        message: { $state: `/ui/connectionForms/${type}/error` },
        type: "error",
      },
      // Only render when error is a non-null string. Initial state
      // seeds `error: null`, action handlers reset to `null` on
      // success, so this gate hides the panel until a real error
      // arrives.
      visible: { $state: `/ui/connectionForms/${type}/error`, neq: null },
    },
    [`${type}_formConnect`]: {
      type: "Button",
      props: { label: "Connect", variant: "primary" },
      on: {
        press: [
          {
            action: "connectConnection",
            params: { connectionType: type },
          },
        ],
      },
    },

    // ── Per-Connection discovered model list (with checkboxes) ──
    [`${type}_perConnModels`]: {
      type: "Stack",
      props: { direction: "vertical", gap: "sm" },
      children: [`${type}_perConnGroup`],
    },
    [`${type}_perConnGroup`]: {
      type: "Stack",
      props: { direction: "vertical", gap: "xs" },
      repeat: { statePath: `/persistent/connectionsByType/${type}` },
      visible: { $item: "connected", eq: true },
      children: [`${type}_perConnGroupHeading`, `${type}_perConnModelRow`],
    },
    [`${type}_perConnGroupHeading`]: {
      type: "Text",
      props: { text: { $item: "name" }, variant: "heading" },
    },
    [`${type}_perConnModelRow`]: {
      type: "Stack",
      props: { direction: "horizontal", gap: "md", align: "center" },
      repeat: { statePath: "models" },
      children: [
        `${type}_perConnCheckbox`,
        `${type}_perConnModelLabel`,
        `${type}_perConnModelCaps`,
      ],
    },
    [`${type}_perConnCheckbox`]: {
      type: "Switch",
      props: {
        label: null,
        name: "starred",
        checked: { $item: "starred" },
      },
      on: {
        change: [
          {
            action: "toggleStar",
            params: {
              connectionId: { $itemParent: "id" },
              modelId: { $item: "id" },
            },
          },
        ],
      },
    },
    [`${type}_perConnModelLabel`]: {
      type: "Text",
      props: { text: { $item: "label" }, variant: "body" },
    },
    [`${type}_perConnModelCaps`]: {
      type: "Text",
      props: {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder is interpreted by the json-render `$template` expression, not by JS
        text: { $template: "${capabilities}" },
        variant: "caption",
      },
    },
  };
}

/** Build the Connections tab body json-render spec. */
export function makeConnectionsTabSpec(): Spec {
  const elements: Record<string, unknown> = {
    root: {
      type: "Stack",
      props: { direction: "vertical", gap: "md" },
      children: ["infoBanner", "typeTabs"],
    },
    infoBanner: {
      type: "Alert",
      props: {
        title: "Chat-capable models",
        message:
          "To chat you need a chat-capable model (brain icon). Other models stay configured but won't appear in the chat composer's model picker.",
        type: "info",
      },
    },
    typeTabs: {
      type: "Tabs",
      props: {
        value: { $bindState: "/ui/activeType" },
        tabs: CONNECTION_TYPES.map((t) => ({
          value: t,
          label: TYPE_LABEL[t],
        })),
      },
      // Tabs renders its `children` once inside the radix Tabs.Root.
      // Each per-type body has a `visible` binding keyed on
      // /ui/activeType so only the active type's body is rendered.
      children: CONNECTION_TYPES.map((t) => `${t}_body`),
    },
  };
  for (const type of CONNECTION_TYPES) {
    Object.assign(elements, tabBodyElements(type));
    // Visibility gate per body — only the active type's body shows.
    const body = elements[`${type}_body`] as Record<string, unknown>;
    body.visible = { $state: "/ui/activeType", eq: type };
  }
  return { root: "root", elements } as unknown as Spec;
}

/** Initial state seed for the Connections tab `StateStore`. The
 * renderer-side bridge merges `/persistent/*` from `Providers` on
 * mount. Per-type form state (`/ui/connectionForms/<type>/*`) is
 * independent for each tab so switching sub-tabs doesn't bleed an
 * API key from one provider into another. */
export function makeConnectionsTabInitialState(): Record<string, unknown> {
  const blankForm = (): Record<string, unknown> => ({
    name: "",
    apiKey: "",
    url: "",
    headers: [] as Array<{ name: string; value: string }>,
    // `null` (not `undefined`) so the Alert's `visible:
    // { neq: null }` gate evaluates correctly — `undefined !== null`
    // is true and would keep the error panel always visible.
    error: null as string | null,
  });
  return {
    persistent: {
      connectionsByType: {
        google: [],
        openai: [],
        anthropic: [],
        "openai-compatible": [],
      },
    },
    ui: {
      activeType: "google",
      connectionForms: {
        google: blankForm(),
        openai: blankForm(),
        anthropic: blankForm(),
        "openai-compatible": blankForm(),
      },
    },
  };
}
