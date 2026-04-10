import { newAdapter } from "@repo/shared/adapters";
import { newRegistry } from "@repo/shared/registry";
import {
  ActionView,
  BadgeView,
  ButtonView,
  CardView,
  FlexView,
  HeadingView,
  LabeledValueView,
  MeterView,
  StatusLightView,
} from "@repo/shared-views";
import type {
  LocalModelConfig,
  ModelManager,
  ModelState,
  RemoteModelConfig,
} from "@statewalker/ai-provider";
import { getModelManager } from "../adapters.js";

export const [getActiveModelsTabView] = newAdapter<FlexView>(
  "view:active-models-tab",
  (ctx) => buildActiveModelsTab(ctx as Record<string, unknown>),
);

function buildActiveModelsTab(ctx: Record<string, unknown>): FlexView {
  const [register] = newRegistry();
  const manager = getModelManager(ctx);

  const deactivateAllAction = new ActionView({
    key: "deactivateAll",
    label: "Deactivate All",
    variant: "danger",
  });

  const activeModelsContainer = new FlexView({
    direction: "column",
    gap: "1rem",
  });

  const gpuMeter = new MeterView({
    label: "WebGPU memory",
    variant: "informative",
  });
  const storageLabel = new LabeledValueView({
    label: "Local storage",
    value: "—",
  });

  const resourcesCard = new CardView({
    header: "Resources",
    children: [gpuMeter, storageLabel],
  });

  function refreshActiveTab(): void {
    const cards: CardView[] = [];
    for (const [key, state] of manager.getStates()) {
      if (state.status !== "ready") continue;
      cards.push(
        createActiveModelCard(key, state, register, manager, refreshActiveTab),
      );
    }
    activeModelsContainer.setChildren(cards);
    deactivateAllAction.disabled = cards.length === 0;
  }

  refreshActiveTab();

  register(
    deactivateAllAction.onSubmit(() => {
      for (const [key, state] of manager.getStates()) {
        if (state.status === "ready") manager.deactivate(key);
      }
      refreshActiveTab();
    }),
  );

  return new FlexView({
    direction: "column",
    gap: "1rem",
    children: [
      new FlexView({
        direction: "row",
        justifyContent: "between",
        alignItems: "center",
        children: [
          new HeadingView({ text: "Active Models", level: 2 }),
          new ButtonView({ action: deactivateAllAction }),
        ],
      }),
      activeModelsContainer,
      resourcesCard,
    ],
  });
}

function createActiveModelCard(
  catalogKey: string,
  state: ModelState,
  register: (cleanup: () => void) => () => void,
  manager: ModelManager,
  onRefresh: () => void,
): CardView {
  const deactivateAction = new ActionView({
    key: "deactivate",
    label: "Deactivate",
    variant: "secondary",
  });

  register(
    deactivateAction.onSubmit(() => {
      manager.deactivate(catalogKey);
      onRefresh();
    }),
  );

  const runtimeBadge = new BadgeView({
    label: state.config.runtime,
    variant: state.config.runtime === "remote" ? "informative" : "positive",
    size: "S",
  });

  const children: import("@repo/shared-views").ViewModel[] = [
    new StatusLightView({ label: "Ready", variant: "positive" }),
  ];

  if (state.config.runtime === "remote") {
    children.push(
      new LabeledValueView({
        label: "Provider",
        value: (state.config as RemoteModelConfig).provider,
      }),
    );
  }
  if (state.config.runtime === "local") {
    const lc = state.config as LocalModelConfig;
    children.push(
      new LabeledValueView({ label: "Family", value: lc.family }),
      new LabeledValueView({ label: "Size", value: lc.size }),
    );
  }

  return new CardView({
    header: new FlexView({
      direction: "row",
      justifyContent: "between",
      alignItems: "center",
      children: [
        new HeadingView({ text: state.config.label, level: 3 }),
        runtimeBadge,
      ],
    }),
    children,
    actions: [deactivateAction],
  });
}
