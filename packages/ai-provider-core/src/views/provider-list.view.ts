import { ActionView, type ColumnDescriptor, TableView } from "@statewalker/workbench-views";
import type { ProviderDescriptor } from "../api/types.js";

/**
 * Provider-list panel — a TableView over `ProviderDescriptor[]` plus
 * three action publishers:
 *
 * - `addAction` — toolbar "Add provider" CTA (no payload).
 * - `removeAction` — submitted with the row's `ProviderDescriptor` when
 *   the user clicks the row's remove button.
 * - `editAction` — submitted with the row's `ProviderDescriptor` when
 *   the user activates a row (e.g. to edit credentials).
 *
 * Pure shell. Wiring is in `AiConfigManager`.
 */
export class ProviderListView extends TableView<ProviderDescriptor> {
  readonly addAction: ActionView;
  readonly removeAction: ActionView<ProviderDescriptor>;
  readonly editAction: ActionView<ProviderDescriptor>;

  constructor(options?: { key?: string }) {
    const addAction = new ActionView({
      key: "ai-config.provider-list.add",
      label: "Add provider",
      variant: "primary",
    });
    const removeAction = new ActionView<ProviderDescriptor>({
      key: "ai-config.provider-list.remove",
    });
    const editAction = new ActionView<ProviderDescriptor>({
      key: "ai-config.provider-list.edit",
    });

    const columns: ColumnDescriptor<ProviderDescriptor>[] = [
      { key: "label", label: "Provider", render: (_, row) => row.label },
      { key: "providerName", label: "Type", render: (_, row) => row.providerName },
      {
        key: "hasCredentials",
        label: "Credentials",
        render: (_, row) => (row.hasCredentials ? "✓" : "✗"),
      },
    ];

    super({
      key: options?.key ?? "ai-config:provider-list",
      rowKey: (row) => (row.instanceId ? `${row.providerId}#${row.instanceId}` : row.providerId),
      selectionMode: "single",
      density: "compact",
      columns,
    });

    this.addAction = addAction;
    this.removeAction = removeAction;
    this.editAction = editAction;

    this.onRowActivate(() => {
      const row = this.activeRow;
      if (row) editAction.submit(row);
    });
  }

  protected override sortRows(rows: ProviderDescriptor[]): ProviderDescriptor[] {
    return rows;
  }
}
