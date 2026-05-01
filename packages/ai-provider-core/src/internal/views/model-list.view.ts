import { ActionView, type ColumnDescriptor, TableView } from "@statewalker/workbench-views";
import type { ModelDescriptor, ModelRole } from "../../public/types.js";

/**
 * Model-list panel — a TableView over `ModelDescriptor[]` plus action
 * publishers for activate (per role) and download.
 *
 * - `activateReasoningAction` — submitted with the row when user
 *   activates it for reasoning.
 * - `activateEmbeddingAction` — same for embedding.
 * - `downloadAction` — submitted with the row when user triggers a
 *   local-model download.
 * - `deleteAction` — submitted with the row when user deletes a local
 *   model's weights.
 *
 * Pure shell. Wiring is in `AiConfigManager`.
 */
export class ModelListView extends TableView<ModelDescriptor> {
  readonly activateReasoningAction: ActionView<ModelDescriptor>;
  readonly activateEmbeddingAction: ActionView<ModelDescriptor>;
  readonly downloadAction: ActionView<ModelDescriptor>;
  readonly deleteAction: ActionView<ModelDescriptor>;

  constructor(options?: { key?: string }) {
    const activateReasoningAction = new ActionView<ModelDescriptor>({
      key: "ai-config.model-list.activate-reasoning",
    });
    const activateEmbeddingAction = new ActionView<ModelDescriptor>({
      key: "ai-config.model-list.activate-embedding",
    });
    const downloadAction = new ActionView<ModelDescriptor>({
      key: "ai-config.model-list.download",
    });
    const deleteAction = new ActionView<ModelDescriptor>({
      key: "ai-config.model-list.delete",
    });

    const columns: ColumnDescriptor<ModelDescriptor>[] = [
      { key: "label", label: "Model", render: (_, row) => row.label },
      { key: "providerId", label: "Provider", render: (_, row) => row.providerId },
      { key: "runtime", label: "Runtime", render: (_, row) => row.runtime },
      {
        key: "kinds",
        label: "Roles",
        render: (_, row) => row.kinds.join(", "),
      },
      { key: "status", label: "Status", render: (_, row) => row.status },
      {
        key: "active",
        label: "Active",
        render: (_, row) => activeBadge(row),
      },
    ];

    super({
      key: options?.key ?? "ai-config:model-list",
      rowKey: (row) => row.catalogKey,
      selectionMode: "single",
      density: "compact",
      columns,
    });

    this.activateReasoningAction = activateReasoningAction;
    this.activateEmbeddingAction = activateEmbeddingAction;
    this.downloadAction = downloadAction;
    this.deleteAction = deleteAction;
  }

  protected override sortRows(rows: ModelDescriptor[]): ModelDescriptor[] {
    return rows;
  }

  /**
   * Helper for renderers that need to know which role(s) the active-flag
   * column should show.
   */
  static activeRoleFlags(row: ModelDescriptor): ModelRole[] {
    const flags: ModelRole[] = [];
    if (row.isActiveReasoning) flags.push("reasoning");
    if (row.isActiveEmbedding) flags.push("embedding");
    return flags;
  }
}

function activeBadge(row: ModelDescriptor): string {
  const flags = ModelListView.activeRoleFlags(row);
  return flags.length === 0 ? "" : flags.join(" + ");
}
