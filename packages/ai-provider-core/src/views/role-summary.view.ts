import { ActionView, FlexView, TextView } from "@statewalker/workbench-views";

/**
 * Summary view: shows the currently active model for each role
 * (reasoning + embedding) plus a "deactivate" action per role.
 *
 * Pure shell — `setReasoning` / `setEmbedding` update the value
 * displayed; consumer wires `deactivateReasoningAction.onSubmit` /
 * `deactivateEmbeddingAction.onSubmit` to the deactivate-model intent.
 */
export class RoleSummaryView extends FlexView {
  readonly reasoningValue: TextView;
  readonly embeddingValue: TextView;
  readonly deactivateReasoningAction: ActionView;
  readonly deactivateEmbeddingAction: ActionView;

  constructor(options?: { key?: string }) {
    const baseKey = options?.key ?? "ai-config:role-summary";
    const reasoningRow = makeRow(`${baseKey}:reasoning`, "Reasoning");
    const embeddingRow = makeRow(`${baseKey}:embedding`, "Embedding");
    super({
      key: baseKey,
      direction: "column",
      gap: "0.5rem",
      children: [reasoningRow.row, embeddingRow.row],
    });
    this.reasoningValue = reasoningRow.value;
    this.embeddingValue = embeddingRow.value;
    this.deactivateReasoningAction = reasoningRow.action;
    this.deactivateEmbeddingAction = embeddingRow.action;
  }

  setReasoning(label: string | undefined): void {
    this.reasoningValue.text = label ?? "—";
    this.deactivateReasoningAction.disabled = !label;
  }

  setEmbedding(label: string | undefined): void {
    this.embeddingValue.text = label ?? "—";
    this.deactivateEmbeddingAction.disabled = !label;
  }
}

function makeRow(
  key: string,
  roleLabel: string,
): {
  row: FlexView;
  value: TextView;
  action: ActionView;
} {
  const labelView = new TextView({ key: `${key}:label`, text: roleLabel });
  const value = new TextView({ key: `${key}:value`, text: "—" });
  const action = new ActionView({
    key: `${key}:deactivate`,
    label: "Deactivate",
    variant: "secondary",
    disabled: true,
  });
  const row = new FlexView({
    key: `${key}:row`,
    direction: "row",
    gap: "0.5rem",
    children: [labelView, value],
  });
  return { row, value, action };
}
