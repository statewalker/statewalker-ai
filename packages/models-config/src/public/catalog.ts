import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react";
import { shadcnComponentDefinitions } from "@json-render/shadcn/catalog";
import { z } from "zod";

/**
 * `models-config` json-render catalog. Re-exports the prebuilt
 * shadcn component definitions and adds one bespoke primitive
 * (`Markdown`) used by the Models List / Local Models detail pane.
 * The action set covers every write the dialogs need; the renderer
 * registers the bindings into `json:catalogs` (catalog id from
 * `constants.ts`).
 */
export const modelsConfigCatalog = defineCatalog(schema, {
  components: {
    ...shadcnComponentDefinitions,
    Markdown: {
      props: z.object({ source: z.string() }),
      description: "Rendered markdown text (formatted lists, headings, etc.)",
    },
    /**
     * Replacement for shadcn `Input` for the Connections form. Two
     * differences from the stock primitive:
     *   1. Disables browser autofill (`autocomplete="off"` for text;
     *      `autocomplete="new-password"` for password). Stock `Input`
     *      lets the browser cross-populate same-named fields across
     *      sibling form sections (the four tabs).
     *   2. For `type: "password"`, renders an eye / eye-off toggle
     *      that flips the input between masked and plain.
     */
    FieldInput: {
      props: z.object({
        label: z.string().nullable(),
        name: z.string(),
        type: z.enum(["text", "password"]).nullable(),
        placeholder: z.string().nullable(),
        value: z.string().nullable(),
      }),
      description:
        "Form input with autofill disabled and a show/hide toggle when type=password.",
    },
  },
  actions: {
    saveConnection: {
      params: z.object({
        // Edit-mode if `id` is set, otherwise create.
        id: z.string().optional(),
        type: z.enum(["openai", "anthropic", "google", "openai-compatible"]),
        name: z.string(),
        url: z.string().optional(),
        apiKey: z.string(),
        headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
      }),
      description: "Persist a new or edited Connection through Providers.",
    },
    removeConnection: {
      params: z.object({ connectionId: z.string() }),
      description: "Delete a Connection by id.",
    },
    refreshConnection: {
      params: z.object({ connectionId: z.string() }),
      description: "Re-fetch the model list for a Connection.",
    },
    starModel: {
      params: z.object({
        connectionId: z.string(),
        modelId: z.string(),
      }),
      description: "Add a model to the starred list (composer quick-pick).",
    },
    unstarModel: {
      params: z.object({
        connectionId: z.string(),
        modelId: z.string(),
      }),
      description: "Remove a model from the starred list.",
    },
    selectModel: {
      params: z.object({
        connectionId: z.string(),
        modelId: z.string(),
      }),
      description: "Set the active model (remote Connection or local).",
    },
    downloadLocalModel: {
      params: z.object({ key: z.string() }),
      description: "Start downloading a local model's weights.",
    },
    cancelDownload: {
      params: z.object({ key: z.string() }),
      description: "Abort an in-progress local-model download.",
    },
    removeLocalModel: {
      params: z.object({ key: z.string() }),
      description: "Delete on-disk weights for a local model.",
    },
    openConnectionsDialog: {
      params: z.object({}),
      description: "Open the Remote Connections dialog.",
    },
    openLocalModelsDialog: {
      params: z.object({}),
      description: "Open the Local Models dialog.",
    },
    closeDialog: {
      params: z.object({
        dialog: z.enum(["modelsList", "remoteConnections", "localModels"]),
      }),
      description: "Close a dialog by name.",
    },
    addHeader: {
      params: z.object({}),
      description: "Append a blank header row to the connection form.",
    },
    removeHeader: {
      params: z.object({ index: z.number() }),
      description: "Remove a header row at the given index.",
    },
  },
});

export type ModelsConfigCatalog = typeof modelsConfigCatalog;
