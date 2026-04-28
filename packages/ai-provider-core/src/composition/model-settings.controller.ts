import { newAdapter } from "@statewalker/shared-adapters";
import { newRegistry } from "@statewalker/shared-registry";
import {
  ActionView,
  BadgeView,
  ButtonView,
  CardView,
  ContentPanelView,
  DockPanelView,
  FlexView,
  GridView,
  HeadingView,
  InlineAlertView,
  type ListBoxItem,
  ListBoxView,
  publishPanel,
  StatusLightView,
  TextView,
} from "@statewalker/workbench-views";
import { getIntents, handleOpenModelSettings, runOpenModelSettings } from "../api/intents.js";
import { getModelManager } from "../core/legacy-adapters.js";
import { ModelListView } from "../core/model-list.view.js";
import { openAddLocalModelDialog } from "./add-local-model.controller.js";
import { openAddRemoteProviderDialog } from "./add-remote-provider.controller.js";
import { buildModelDetailPanel } from "./model-detail.controller.js";

/** Shared ModelListView adapter, so other controllers can subscribe. */
export const [getModelListView, setModelListView] = newAdapter<ModelListView>("view:model-list");

/**
 * Publishes the single-page Model Settings DockPanelView driven by
 * ModelListView. Handles the `openModelSettings` intent: each invocation
 * re-publishes the panel (the UI registry dedupes by key).
 *
 * Legacy `{ tab }` payload is accepted but ignored — logs a deprecation
 * warning so callers can migrate.
 */
export function createModelSettingsController(ctx: Record<string, unknown>): () => Promise<void> {
  const [register, cleanup] = newRegistry();
  const intents = getIntents(ctx);
  const manager = getModelManager(ctx);

  const view = new ModelListView();
  setModelListView(ctx, view);

  // Keep the view synced with the store. (Provider settings + activeModels
  // come from a separate source — the active-models-lifecycle controller
  // populates them; on first render we default to empty snapshots.)
  const refresh = () => {
    view.recompute(
      manager.store.getStates(),
      { activeModels: { reasoning: [], embedding: [] } },
      { reasoning: [], embedding: [] },
    );
  };
  register(manager.store.onUpdate(refresh));
  refresh();

  register(
    handleOpenModelSettings(intents, (intent) => {
      if (intent.payload?.tab) {
        console.warn(
          "[ai-provider] runOpenModelSettings { tab } payload is deprecated and ignored.",
        );
      }
      intent.resolve();

      const panel = buildSettingsPanel(ctx, view);
      register(publishPanel(ctx, panel));
      return true;
    }),
  );

  return cleanup;
}

function buildSettingsPanel(ctx: Record<string, unknown>, view: ModelListView): DockPanelView {
  const [register] = newRegistry();
  const manager = getModelManager(ctx);

  const noReasoningBanner = new InlineAlertView({
    content: "No reasoning model is active — activate one to start chatting.",
    variant: "notice",
  });

  const addRemoteAction = new ActionView({
    key: "addRemote",
    label: "+ Add Remote Provider",
    variant: "primary",
  });
  const addLocalAction = new ActionView({
    key: "addLocal",
    label: "+ Add Local Model",
    variant: "secondary",
  });
  register(addRemoteAction.onSubmit(() => openAddRemoteProviderDialog(ctx, manager)));
  register(addLocalAction.onSubmit(() => openAddLocalModelDialog(ctx, manager)));

  const header = new FlexView({
    direction: "row",
    justifyContent: "between",
    alignItems: "center",
    children: [
      new HeadingView({ text: "Models", level: 2 }),
      new FlexView({
        direction: "row",
        gap: "0.5rem",
        children: [
          new ButtonView({ action: addRemoteAction }),
          new ButtonView({ action: addLocalAction }),
        ],
      }),
    ],
  });

  const list = new ListBoxView({
    selectionMode: "single",
    items: buildRows(view),
  });
  const detail = new ContentPanelView({ header: "Select a model" });
  const body = new GridView({
    columns: ["minmax(280px, 1fr)", "2fr"],
    gap: "1rem",
    children: [list, detail],
  });

  const groupsContainer = new FlexView({
    direction: "column",
    gap: "1rem",
    children: [],
  });

  const syncPanel = () => {
    // Alert
    const hasBanner = groupsContainer.children.includes(noReasoningBanner);
    if (!view.hasActiveReasoning && !hasBanner) {
      groupsContainer.addChild(noReasoningBanner);
    } else if (view.hasActiveReasoning && hasBanner) {
      groupsContainer.setChildren(groupsContainer.children.filter((c) => c !== noReasoningBanner));
    }
    list.items = buildRows(view);
  };
  register(view.onUpdate(syncPanel));

  register(
    list.onUpdate(() => {
      const selected = [...list.selectedKeys][0];
      if (!selected) return;
      detail.setChildren([
        buildModelDetailPanel(ctx, register, manager, selected, () => {
          view.recompute(
            manager.store.getStates(),
            { activeModels: { reasoning: [], embedding: [] } },
            { reasoning: [], embedding: [] },
          );
        }),
      ]);
    }),
  );

  // Initial children — groups rendered as cards, each with its rows below.
  const groupCards = view.groups.map((g) => buildGroupCard(g));
  groupsContainer.setChildren([...groupCards]);
  syncPanel();

  const content = new FlexView({
    direction: "column",
    gap: "1rem",
    children: [header, groupsContainer, body],
  });

  return new DockPanelView({
    key: "model-settings",
    label: "Model Settings",
    area: "center",
    closable: true,
    content,
  });
}

function buildGroupCard(group: ReturnType<ModelListView["groups"]["slice"]>[number]): CardView {
  const statusLight = new StatusLightView({
    label: group.configured ? "Configured" : "Not configured",
    variant: group.configured ? "positive" : "neutral",
  });
  const headingRow = new FlexView({
    direction: "row",
    justifyContent: "between",
    alignItems: "center",
    children: [new HeadingView({ text: group.label, level: 3 }), statusLight],
  });
  const badges = group.rows.map(
    (r) =>
      new BadgeView({
        label: `${statusIcon(r.status)} ${r.label}${
          r.activeForReasoning ? " · Active · reasoning" : ""
        }${r.activeForEmbedding ? " · Active · embedding" : ""}`,
        variant: r.activeForReasoning ? "positive" : "neutral",
        size: "S",
      }),
  );
  return new CardView({
    header: headingRow,
    children: [
      new FlexView({
        direction: "row",
        wrap: "wrap",
        gap: "0.5rem",
        children: badges,
      }),
      new TextView({
        text: `${group.rows.length} model${group.rows.length === 1 ? "" : "s"}`,
      }),
    ],
  });
}

function buildRows(view: ModelListView): ListBoxItem[] {
  const items: ListBoxItem[] = [];
  for (const g of view.groups) {
    for (const r of g.rows) {
      const unavailable = r.available ? "" : " · unavailable";
      const badge = r.engineBadge ? ` · ${r.engineBadge}` : "";
      items.push({
        key: r.key,
        label: `${statusIcon(r.status)} ${r.label}${r.activeForReasoning ? "  ●" : ""}`,
        description: `${g.label}${badge}${unavailable}`,
      });
    }
  }
  return items;
}

function statusIcon(status: string): string {
  return status === "ready"
    ? "●"
    : status === "downloaded"
      ? "↓"
      : status === "downloading" || status === "loading"
        ? "◌"
        : status === "partial"
          ? "⇣"
          : status === "error"
            ? "✗"
            : "○";
}

// Re-export intents helper for consumers that want to trigger the panel.
export { runOpenModelSettings };
