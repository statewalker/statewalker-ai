import type { Spec } from "@json-render/core";

/**
 * json-render spec for the Settings dialog's "Local Models" tab body.
 * No surrounding Dialog (the Settings dialog provides that wrapping).
 * Rows repeat over `/persistent/localModelsList` (projected by the
 * view-layer state bridge from the curated catalog + the
 * `LocalModels` adapter's persisted config + status).
 */
export function makeLocalModelsTabSpec(): Spec {
  const spec = {
    root: "root",
    elements: {
      root: {
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
          className: "ai-local-models-row",
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
          press: [{ action: "downloadLocalModel", params: { key: { $item: "key" } } }],
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
          press: [{ action: "removeLocalModel", params: { key: { $item: "key" } } }],
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
          press: [{ action: "selectLocalModel", params: { key: { $item: "key" } } }],
        },
      },
    },
  };
  return spec as unknown as Spec;
}

/** Initial state seed for the Local Models tab `StateStore`. */
export function makeLocalModelsTabInitialState(): Record<string, unknown> {
  return {
    persistent: {
      localModelsList: [] as unknown[],
    },
    ui: {
      downloads: {} as Record<string, { phase: string; progress: number; message: string }>,
    },
  };
}
