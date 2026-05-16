import type { Spec } from "@json-render/core";

/**
 * Build the json-render spec hosting all three dialogs (Models List,
 * Remote Connections, Local Models) as siblings under a transparent
 * `Stack` root. Each `Dialog` has its own `openPath`; the three
 * commands flip the corresponding state flag in the renderer-side
 * store. Children are placeholders pending Group 6 of the change.
 */
export function makeModelsConfigSpec(): Spec {
  return {
    root: "overlayRoot",
    elements: {
      overlayRoot: {
        type: "Stack",
        props: { direction: "vertical", gap: "none" },
        children: ["modelsListDialog", "connectionsDialog", "localModelsDialog"],
      },
      // ── Models List dialog ─────────────────────────────
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
        children: ["modelsListPlaceholder"],
      },
      modelsListPlaceholder: {
        type: "Text",
        props: {
          text: "Models list — populated by Group 6.",
          variant: "muted",
        },
      },

      // ── Remote Connections dialog ──────────────────────
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
        children: ["connectionsPlaceholder"],
      },
      connectionsPlaceholder: {
        type: "Text",
        props: {
          text: "Connections list + Add/Edit form — populated by Group 6.",
          variant: "muted",
        },
      },

      // ── Local Models dialog ────────────────────────────
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
        props: { direction: "horizontal", gap: "md" },
        children: ["localModelsPlaceholder"],
      },
      localModelsPlaceholder: {
        type: "Text",
        props: {
          text: "Local-models list + download pane — populated by Group 6.",
          variant: "muted",
        },
      },
    },
  } satisfies Spec;
}

/** Initial state seed for the json-render `StateStore`. The
 * renderer-side bridge merges `/persistent/*` from `Providers`/
 * `LocalModels` snapshots on mount. */
export function makeInitialState(): Record<string, unknown> {
  return {
    persistent: {
      connections: [],
      starred: [],
      local: { downloaded: [], lastActivatedKey: undefined },
      active: { providerId: undefined, modelId: undefined },
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
