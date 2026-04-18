import {
  ActionGroupView,
  ActionView,
  CheckboxView,
  ContentPanelView,
  DividerView,
  FlexView,
  LabeledValueView,
  ProgressBarView,
  StatusLightView,
  TextView,
} from "@repo/shared-views";
import type {
  EngineId,
  LocalModelConfig,
  ModelConfig,
  ModelManager,
  RemoteModelConfig,
} from "@statewalker/ai-provider";
import { modelKinds } from "@statewalker/ai-provider";
import {
  persistDownloadStatus,
  removeDownloadStatus,
} from "../download-status-store.js";
import { detectAvailableEngines } from "../engine-detection.js";
import { resolveActivationSettings } from "../resolve-settings.js";

const ENGINE_BADGES: Record<EngineId, string> = {
  tjs: "WASM",
  webllm: "WebGPU",
  llamacpp: "Native",
};

/**
 * Build a ContentPanelView that reflects the state of one model and wires
 * activation/download/delete actions. Subscribes to the store so live
 * status updates are reflected without controller plumbing.
 */
export function buildModelDetailPanel(
  ctx: Record<string, unknown>,
  register: (cleanup: () => void) => () => void,
  manager: ModelManager,
  catalogKey: string,
  onRefresh: () => void,
): ContentPanelView {
  const panel = new ContentPanelView({ header: "" });
  const state = manager.store.getState(catalogKey);
  if (!state) {
    panel.header = "Unknown model";
    return panel;
  }

  const { config } = state;
  const isLocal = config.runtime === "local";
  const engine = isLocal ? (config as LocalModelConfig).engine : undefined;
  const engineBadge = engine ? ENGINE_BADGES[engine] : undefined;
  panel.header = engineBadge
    ? `${config.label} — ${engineBadge}`
    : config.label;

  const metadata = buildMetadata(config);
  const statusLight = new StatusLightView({
    label: state.status,
    variant: statusVariant(state.status),
  });
  const initialKinds = new Set(modelKinds(config));
  const reasoningCheckbox = new CheckboxView({
    key: "kind:reasoning",
    label: "Reasoning",
    isSelected: initialKinds.has("reasoning"),
  });
  const embeddingCheckbox = new CheckboxView({
    key: "kind:embedding",
    label: "Embedding",
    isSelected: initialKinds.has("embedding"),
  });
  const progressBar = new ProgressBarView({
    label: "Progress",
    showValueLabel: true,
  });
  const progressMessage = new TextView({ text: "" });

  const downloadAction = new ActionView({
    key: "download",
    label: state.status === "partial" ? "Resume Download" : "Download",
    variant: "primary",
    disabled:
      !isLocal ||
      state.status === "downloaded" ||
      state.status === "ready" ||
      state.status === "downloading" ||
      state.status === "loading",
  });
  const activateAction = new ActionView({
    key: "activate",
    label: isLocal ? "Load Model" : "Activate",
    variant: "primary",
    disabled:
      state.status === "ready" ||
      state.status === "loading" ||
      state.status === "downloading" ||
      (isLocal && state.status !== "downloaded"),
  });
  const deactivateAction = new ActionView({
    key: "deactivate",
    label: "Deactivate",
    variant: "secondary",
    disabled: state.status !== "ready",
  });
  const deleteWeightsAction = new ActionView({
    key: "deleteWeights",
    label: "Delete Weights",
    variant: "danger",
    disabled:
      !isLocal ||
      state.status === "not-downloaded" ||
      state.status === "downloading",
  });
  const cancelAction = new ActionView({
    key: "cancel",
    label: "Cancel",
    variant: "neutral",
    disabled: true,
  });
  const retryAction = new ActionView({
    key: "retry",
    label: "Retry",
    variant: "primary",
    disabled: state.status !== "error",
  });

  // If the engine this model uses isn't available on the current host,
  // lock out the actions that would try to run it. Remote models and `tjs`
  // are unaffected since they run anywhere.
  if (engine && engine !== "tjs") {
    void detectAvailableEngines().then((available) => {
      if (!available[engine]) {
        downloadAction.disabled = true;
        activateAction.disabled = true;
        retryAction.disabled = true;
        progressMessage.text = `${engine} is not available on this runtime`;
      }
    });
  }

  let abortController: AbortController | undefined;

  register(
    downloadAction.onSubmit(async () => {
      downloadAction.disabled = true;
      cancelAction.disabled = false;
      abortController = new AbortController();
      try {
        for await (const p of manager.download(
          catalogKey,
          abortController.signal,
        )) {
          progressBar.value = p.progress != null ? p.progress * 100 : undefined;
          progressBar.label = p.phase;
          progressMessage.text = p.message;
        }
        if (manager.files) {
          await persistDownloadStatus(
            manager.files,
            catalogKey,
            config.modelId,
            "downloaded",
            undefined,
            isLocal ? (config as LocalModelConfig).engine : undefined,
          );
        }
      } catch {
        const cur = manager.store.getState(catalogKey);
        if (manager.files && cur?.status === "partial") {
          const dp = manager.store.getDownloadProgress(catalogKey);
          await persistDownloadStatus(
            manager.files,
            catalogKey,
            config.modelId,
            "partial",
            dp
              ? {
                  bytesDownloaded: dp.bytesDownloaded ?? 0,
                  bytesTotal: dp.bytesTotal ?? 0,
                }
              : undefined,
            isLocal ? (config as LocalModelConfig).engine : undefined,
          );
        }
      } finally {
        cancelAction.disabled = true;
        abortController = undefined;
        onRefresh();
      }
    }),
  );

  const runActivate = async () => {
    activateAction.disabled = true;
    retryAction.disabled = true;
    cancelAction.disabled = false;
    abortController = new AbortController();
    try {
      const settings = resolveActivationSettings(ctx, manager, catalogKey);
      for await (const p of manager.activate(catalogKey, {
        settings,
        signal: abortController.signal,
      })) {
        progressBar.value = p.progress != null ? p.progress * 100 : undefined;
        progressBar.label = p.phase;
        progressMessage.text = p.error?.message ?? p.message;
      }
      const final = manager.store.getState(catalogKey);
      if (final?.status === "ready") {
        manager.store.setActiveModelKey(catalogKey, config.label);
      }
    } finally {
      cancelAction.disabled = true;
      abortController = undefined;
      onRefresh();
    }
  };

  register(activateAction.onSubmit(runActivate));

  register(
    retryAction.onSubmit(async () => {
      // Move out of "error" back to the prior download status so the
      // activate flow can re-enter. For local models that means "downloaded"
      // if the weights are still present, otherwise "not-downloaded" so
      // the user is steered to re-download.
      if (isLocal) {
        const next =
          manager.store.getDownloadProgress(catalogKey) != null
            ? "partial"
            : "downloaded";
        manager.store.setStatus(catalogKey, next);
      } else {
        manager.store.setStatus(catalogKey, "not-downloaded");
      }
      await runActivate();
    }),
  );

  register(
    cancelAction.onSubmit(() => {
      abortController?.abort();
      manager.cancel(catalogKey);
    }),
  );

  register(
    deactivateAction.onSubmit(() => {
      manager.deactivate(catalogKey);
      onRefresh();
    }),
  );

  register(
    deleteWeightsAction.onSubmit(async () => {
      await manager.deleteLocal(catalogKey);
      if (manager.files) {
        await removeDownloadStatus(manager.files, catalogKey);
      }
      onRefresh();
    }),
  );

  const applyKinds = () => {
    const next: ("reasoning" | "embedding")[] = [];
    if (reasoningCheckbox.isSelected) next.push("reasoning");
    if (embeddingCheckbox.isSelected) next.push("embedding");
    (manager.store.catalog[catalogKey] as ModelConfig).kinds = next;
    onRefresh();
  };
  register(reasoningCheckbox.onUpdate(applyKinds));
  register(embeddingCheckbox.onUpdate(applyKinds));

  register(
    manager.store.onUpdate(() => {
      const updated = manager.store.getState(catalogKey);
      if (!updated) return;
      statusLight.label = updated.status;
      statusLight.variant = statusVariant(updated.status);
      retryAction.disabled = updated.status !== "error";
    }),
  );

  const actions = isLocal
    ? [
        downloadAction,
        activateAction,
        retryAction,
        deactivateAction,
        deleteWeightsAction,
        cancelAction,
      ]
    : [activateAction, retryAction, deactivateAction, cancelAction];

  panel.setChildren([
    statusLight,
    ...metadata,
    new DividerView({}),
    new FlexView({
      direction: "row",
      gap: "0.5rem",
      children: [reasoningCheckbox, embeddingCheckbox],
    }),
    new DividerView({}),
    progressBar,
    progressMessage,
    new FlexView({
      direction: "row",
      gap: "0.5rem",
      children: [new ActionGroupView({ children: actions })],
    }),
  ]);

  return panel;
}

function buildMetadata(config: ModelConfig): LabeledValueView[] {
  const rows: LabeledValueView[] = [
    new LabeledValueView({ label: "Runtime", value: config.runtime }),
    new LabeledValueView({ label: "Model ID", value: config.modelId }),
  ];
  if (config.runtime === "remote") {
    const r = config as RemoteModelConfig;
    rows.push(new LabeledValueView({ label: "Provider", value: r.provider }));
    if (r.providerInstanceId) {
      rows.push(
        new LabeledValueView({
          label: "Instance",
          value: r.providerInstanceId,
        }),
      );
    }
  } else {
    const l = config as LocalModelConfig;
    rows.push(
      new LabeledValueView({
        label: "Engine",
        value: `${ENGINE_BADGES[l.engine]} (${l.engine})`,
      }),
      new LabeledValueView({ label: "Family", value: l.family }),
      new LabeledValueView({ label: "Quantization", value: l.dtype }),
      new LabeledValueView({ label: "Size", value: l.size }),
    );
  }
  return rows;
}

function statusVariant(
  status: string,
): "positive" | "negative" | "notice" | "neutral" {
  if (status === "ready") return "positive";
  if (status === "error") return "negative";
  if (status === "loading" || status === "downloading") return "notice";
  return "neutral";
}
