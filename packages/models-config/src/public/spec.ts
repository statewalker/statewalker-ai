import type { Spec } from "@json-render/core";

/**
 * Build the json-render spec hosting all three dialogs (Models List,
 * Remote Connections, Local Models) as siblings under a transparent
 * `Stack` root. Each `Dialog` has its own `openPath`; the three
 * commands flip the corresponding state flag in the renderer-side
 * store.
 *
 * The state model is two-segment:
 *   `/persistent/*` — mirror of Providers.config + LocalModels;
 *      includes the flattened `allModels` and `localModelsList`
 *      arrays computed by the renderer-side bridge.
 *   `/ui/*` — dialog open flags, search query, filters,
 *      in-progress connection form, download progress.
 *
 * The return is cast through `unknown` because shadcn's Zod-derived
 * prop types reject the runtime `PropExpression` forms (`$state`,
 * `$item`, `$cond`, `$bindState`, `$bindItem`) that json-render's
 * resolver supports. Structural validation happens at runtime via
 * `validateSpec` (see `spec.test.ts`).
 */
export function makeModelsConfigSpec(): Spec {
  const spec = {
    root: "overlayRoot",
    elements: {
      overlayRoot: {
        type: "Stack",
        props: { direction: "vertical", gap: "none" },
        children: ["modelsListDialog", "connectionsDialog", "localModelsDialog"],
      },

      // ── Models List dialog ─────────────────────────────────
      modelsListDialog: {
        type: "Dialog",
        props: {
          title: "Available Models",
          description: null,
          openPath: "/ui/dialogs/modelsList/open",
        },
        children: ["modelsListBody"],
      },
      modelsListBody: {
        type: "Stack",
        props: { direction: "vertical", gap: "md" },
        children: ["modelsListFilters", "modelsListRows", "modelsListFooter"],
      },
      modelsListFilters: {
        type: "Stack",
        props: { direction: "horizontal", gap: "sm" },
        children: ["modelsListSearchInput", "modelsListStarredSwitch"],
      },
      modelsListSearchInput: {
        type: "Input",
        props: {
          label: "Search",
          name: "modelsListSearch",
          type: "text",
          placeholder: "Filter by model id…",
          value: { $bindState: "/ui/search" },
        },
      },
      modelsListStarredSwitch: {
        type: "Switch",
        props: {
          label: "Starred only",
          name: "starredOnly",
          checked: { $bindState: "/ui/filters/starredOnly" },
        },
      },
      modelsListRows: {
        type: "Stack",
        props: { direction: "vertical", gap: "sm" },
        children: ["modelsListRow"],
      },
      modelsListRow: {
        type: "Card",
        props: {
          title: null,
          description: null,
          maxWidth: "full",
          centered: false,
          className: "models-config-row",
        },
        repeat: { statePath: "/persistent/allModels" },
        children: ["modelsListRowStack"],
      },
      modelsListRowStack: {
        type: "Stack",
        props: { direction: "horizontal", gap: "md", align: "center" },
        children: [
          "modelsListRowLabel",
          "modelsListRowProvider",
          "modelsListRowCapabilities",
          "modelsListRowStar",
          "modelsListRowUse",
        ],
      },
      modelsListRowLabel: {
        type: "Text",
        props: {
          text: { $item: "label" },
          variant: "body",
        },
      },
      modelsListRowProvider: {
        type: "Badge",
        props: {
          text: { $item: "connectionName" },
          variant: "secondary",
        },
      },
      modelsListRowCapabilities: {
        type: "Text",
        props: {
          // biome-ignore lint/style/noUnusedTemplateLiteral: $template is a json-render expression, not a JS template literal
          text: { $template: "${capabilities}" },
          variant: "caption",
        },
      },
      modelsListRowStar: {
        type: "Button",
        props: {
          label: {
            $cond: { $item: "starred", eq: true },
            $then: "★ Unstar",
            $else: "☆ Star",
          },
          variant: "secondary",
        },
        on: {
          press: [
            {
              action: {
                $cond: { $item: "starred", eq: true },
                $then: "unstarModel",
                $else: "starModel",
              },
              params: {
                connectionId: { $item: "connectionId" },
                modelId: { $item: "modelId" },
              },
            },
          ],
        },
      },
      modelsListRowUse: {
        type: "Button",
        props: {
          label: {
            $cond: { $item: "active", eq: true },
            $then: "Active",
            $else: "Use",
          },
          variant: "primary",
          disabled: { $item: "active" },
        },
        on: {
          press: [
            {
              action: "selectModel",
              params: {
                connectionId: { $item: "connectionId" },
                modelId: { $item: "modelId" },
              },
            },
          ],
        },
      },
      modelsListFooter: {
        type: "Stack",
        props: { direction: "horizontal", gap: "md", justify: "end" },
        children: ["modelsListFooterConnections", "modelsListFooterLocal"],
      },
      modelsListFooterConnections: {
        type: "Button",
        props: { label: "Manage Connections…", variant: "secondary" },
        on: {
          press: [{ action: "openConnectionsDialog", params: {} }],
        },
      },
      modelsListFooterLocal: {
        type: "Button",
        props: { label: "Local Models…", variant: "secondary" },
        on: {
          press: [{ action: "openLocalModelsDialog", params: {} }],
        },
      },

      // ── Remote Connections dialog ──────────────────────────
      connectionsDialog: {
        type: "Dialog",
        props: {
          title: "Remote Connections",
          description: null,
          openPath: "/ui/dialogs/remoteConnections/open",
        },
        children: ["connectionsBody"],
      },
      connectionsBody: {
        type: "Stack",
        props: { direction: "vertical", gap: "md" },
        children: ["connectionsListSection", "connectionsFormSection"],
      },

      // List of existing connections.
      connectionsListSection: {
        type: "Stack",
        props: { direction: "vertical", gap: "sm" },
        children: ["connectionRow"],
      },
      connectionRow: {
        type: "Card",
        props: {
          title: null,
          description: null,
          maxWidth: "full",
          centered: false,
          className: "models-config-connection-row",
        },
        repeat: { statePath: "/persistent/connections" },
        children: ["connectionRowStack"],
      },
      connectionRowStack: {
        type: "Stack",
        props: { direction: "horizontal", gap: "md", align: "center" },
        children: [
          "connectionRowName",
          "connectionRowType",
          "connectionRowRefresh",
          "connectionRowRemove",
        ],
      },
      connectionRowName: {
        type: "Text",
        props: { text: { $item: "name" }, variant: "body" },
      },
      connectionRowType: {
        type: "Badge",
        props: { text: { $item: "type" }, variant: "outline" },
      },
      connectionRowRefresh: {
        type: "Button",
        props: { label: "Refresh", variant: "secondary" },
        on: {
          press: [
            {
              action: "refreshConnection",
              params: { connectionId: { $item: "id" } },
            },
          ],
        },
      },
      connectionRowRemove: {
        type: "Button",
        props: { label: "Remove", variant: "danger" },
        on: {
          press: [
            {
              action: "removeConnection",
              params: { connectionId: { $item: "id" } },
            },
          ],
        },
      },

      // Add / Edit connection form.
      connectionsFormSection: {
        type: "Card",
        props: {
          title: "Add Connection",
          description: null,
          maxWidth: "full",
          centered: false,
          className: "models-config-connection-form",
        },
        children: ["connectionFormStack"],
      },
      connectionFormStack: {
        type: "Stack",
        props: { direction: "vertical", gap: "sm" },
        children: [
          "connectionFormType",
          "connectionFormName",
          "connectionFormUrl",
          "connectionFormApiKey",
          "connectionFormHeadersLabel",
          "connectionFormHeadersList",
          "connectionFormAddHeader",
          "connectionFormError",
          "connectionFormButtons",
        ],
      },
      connectionFormType: {
        type: "Select",
        props: {
          label: "Type",
          name: "type",
          options: ["openai", "anthropic", "google", "openai-compatible"],
          value: { $bindState: "/ui/connectionForm/type" },
        },
      },
      connectionFormName: {
        type: "Input",
        props: {
          label: "Name",
          name: "name",
          type: "text",
          placeholder: "e.g. Work OpenAI",
          value: { $bindState: "/ui/connectionForm/name" },
        },
      },
      connectionFormUrl: {
        type: "Input",
        props: {
          label: "URL (optional for canonical types)",
          name: "url",
          type: "text",
          placeholder: "https://…",
          value: { $bindState: "/ui/connectionForm/url" },
        },
      },
      connectionFormApiKey: {
        type: "Input",
        props: {
          label: "API Key",
          name: "apiKey",
          type: "password",
          placeholder: "sk-…",
          value: { $bindState: "/ui/connectionForm/apiKey" },
        },
      },
      connectionFormHeadersLabel: {
        type: "Text",
        props: { text: "Headers (optional)", variant: "caption" },
      },
      connectionFormHeadersList: {
        type: "Stack",
        props: { direction: "vertical", gap: "sm" },
        children: ["connectionFormHeaderRow"],
      },
      connectionFormHeaderRow: {
        type: "Stack",
        props: { direction: "horizontal", gap: "sm", align: "center" },
        repeat: { statePath: "/ui/connectionForm/headers" },
        children: [
          "connectionFormHeaderName",
          "connectionFormHeaderValue",
          "connectionFormHeaderRemove",
        ],
      },
      connectionFormHeaderName: {
        type: "Input",
        props: {
          label: "Name",
          name: "headerName",
          type: "text",
          placeholder: "X-Header",
          value: { $bindItem: "name" },
        },
      },
      connectionFormHeaderValue: {
        type: "Input",
        props: {
          label: "Value",
          name: "headerValue",
          type: "text",
          placeholder: "value",
          value: { $bindItem: "value" },
        },
      },
      connectionFormHeaderRemove: {
        type: "Button",
        props: { label: "×", variant: "secondary" },
        on: {
          press: [
            {
              action: "removeHeader",
              params: { index: { $index: true } },
            },
          ],
        },
      },
      connectionFormAddHeader: {
        type: "Button",
        props: { label: "Add header", variant: "secondary" },
        on: { press: [{ action: "addHeader", params: {} }] },
      },
      connectionFormError: {
        type: "Alert",
        props: {
          title: "Error",
          message: { $state: "/ui/connectionForm/error" },
          type: "error",
        },
        visible: { $state: "/ui/connectionForm/error", neq: null },
      },
      connectionFormButtons: {
        type: "Stack",
        props: { direction: "horizontal", gap: "sm", justify: "end" },
        children: ["connectionFormSave", "connectionFormCancel"],
      },
      connectionFormSave: {
        type: "Button",
        props: { label: "Save & Test", variant: "primary" },
        on: {
          press: [
            {
              action: "saveConnection",
              params: {
                id: { $state: "/ui/connectionForm/editingId" },
                type: { $state: "/ui/connectionForm/type" },
                name: { $state: "/ui/connectionForm/name" },
                url: { $state: "/ui/connectionForm/url" },
                apiKey: { $state: "/ui/connectionForm/apiKey" },
                headers: { $state: "/ui/connectionForm/headers" },
              },
            },
          ],
        },
      },
      connectionFormCancel: {
        type: "Button",
        props: { label: "Close", variant: "secondary" },
        on: {
          press: [
            {
              action: "closeDialog",
              params: { dialog: "remoteConnections" },
            },
          ],
        },
      },

      // ── Local Models dialog ────────────────────────────────
      localModelsDialog: {
        type: "Dialog",
        props: {
          title: "Local Models",
          description: null,
          openPath: "/ui/dialogs/localModels/open",
        },
        children: ["localModelsBody"],
      },
      localModelsBody: {
        type: "Stack",
        props: { direction: "vertical", gap: "md" },
        children: ["localModelsHelp", "localModelsList"],
      },
      localModelsHelp: {
        type: "Text",
        props: {
          text: "Download models to use them offline (transformers.js runs in the browser on WASM).",
          variant: "muted",
        },
      },
      localModelsList: {
        type: "Stack",
        props: { direction: "vertical", gap: "sm" },
        children: ["localModelRow"],
      },
      localModelRow: {
        type: "Card",
        props: {
          title: null,
          description: null,
          maxWidth: "full",
          centered: false,
          className: "models-config-local-row",
        },
        repeat: { statePath: "/persistent/localModelsList" },
        children: ["localModelRowStack"],
      },
      localModelRowStack: {
        type: "Stack",
        props: { direction: "vertical", gap: "sm" },
        children: ["localModelRowHeader", "localModelRowDescription", "localModelRowActions"],
      },
      localModelRowHeader: {
        type: "Stack",
        props: { direction: "horizontal", gap: "md", align: "center" },
        children: [
          "localModelRowLabel",
          "localModelRowFamily",
          "localModelRowSize",
          "localModelRowStatus",
        ],
      },
      localModelRowLabel: {
        type: "Text",
        props: { text: { $item: "label" }, variant: "body" },
      },
      localModelRowFamily: {
        type: "Badge",
        props: { text: { $item: "family" }, variant: "outline" },
      },
      localModelRowSize: {
        type: "Text",
        props: { text: { $item: "size" }, variant: "caption" },
      },
      localModelRowStatus: {
        type: "Badge",
        props: { text: { $item: "status" }, variant: "secondary" },
      },
      localModelRowDescription: {
        type: "Markdown",
        props: { source: { $item: "description" } },
      },
      localModelRowActions: {
        type: "Stack",
        props: { direction: "horizontal", gap: "sm", justify: "end" },
        children: ["localModelRowDownload", "localModelRowRemove", "localModelRowUse"],
      },
      localModelRowDownload: {
        type: "Button",
        props: {
          label: "Download",
          variant: "primary",
          disabled: { $item: "downloaded" },
        },
        on: {
          press: [
            {
              action: "downloadLocalModel",
              params: { key: { $item: "key" } },
            },
          ],
        },
      },
      localModelRowRemove: {
        type: "Button",
        props: {
          label: "Remove",
          variant: "danger",
          disabled: {
            $cond: { $item: "downloaded", eq: true },
            $then: false,
            $else: true,
          },
        },
        on: {
          press: [
            {
              action: "removeLocalModel",
              params: { key: { $item: "key" } },
            },
          ],
        },
      },
      localModelRowUse: {
        type: "Button",
        props: {
          label: {
            $cond: { $item: "active", eq: true },
            $then: "Active",
            $else: "Use",
          },
          variant: "secondary",
          disabled: {
            $cond: { $item: "downloaded", eq: true },
            $then: { $item: "active" },
            $else: true,
          },
        },
        on: {
          press: [
            {
              action: "selectModel",
              params: {
                connectionId: "local",
                modelId: { $item: "key" },
              },
            },
          ],
        },
      },
    },
  };
  return spec as unknown as Spec;
}

/** Initial state seed for the json-render `StateStore`. The
 * renderer-side bridge merges `/persistent/*` from `Providers` /
 * `LocalModels` snapshots on mount. */
export function makeInitialState(): Record<string, unknown> {
  return {
    persistent: {
      connections: [],
      starred: [],
      local: { downloaded: [], lastActivatedKey: undefined },
      active: { providerId: undefined, modelId: undefined },
      allModels: [],
      localModelsList: [],
    },
    ui: {
      dialogs: {
        modelsList: { open: false },
        remoteConnections: { open: false },
        localModels: { open: false },
      },
      search: "",
      filters: {
        capabilities: [],
        starredOnly: false,
        providerTypes: [],
      },
      connectionForm: {
        editingId: undefined,
        type: "openai",
        name: "",
        url: "",
        apiKey: "",
        headers: [] as Array<{ name: string; value: string }>,
        error: undefined,
      },
      downloads: {} as Record<string, { phase: string; progress: number; message: string }>,
      selectedModel: { connectionId: undefined, modelId: undefined },
    },
  };
}
