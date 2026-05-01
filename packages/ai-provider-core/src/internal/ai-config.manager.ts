import type { Intents } from "@statewalker/shared-intents";
import { newRegistry } from "@statewalker/shared-registry";
import type { Workspace } from "@statewalker/workspace-api";
import { ActiveEmbeddingModel, ActiveReasoningModel } from "../public/adapters.js";
import {
  handleActivationProgress,
  handleActiveModelChanged,
  handleProvidersChanged,
  runActivateModel,
  runCancelDownload,
  runConfigureProvider,
  runDeactivateModel,
  runDeleteLocalModel,
  runDownloadModel,
  runListModels,
  runListProviders,
  runRemoveProvider,
} from "../public/intents.js";
import type { ModelDescriptor, ProviderDescriptor, ProviderName } from "../public/types.js";
import type { AiConfigView } from "./views/ai-config.view.js";

/**
 * Wire `AiConfigView` to the intent surface + the active-model
 * adapters.
 *
 * Subscriptions:
 * - `providers-changed` broadcast → refresh provider list.
 * - `active-model-changed` broadcast → refresh role summary +
 *   model-list active flags.
 * - `activation-progress` broadcast → forward to add-local-model
 *   progress UI.
 *
 * Action wiring (view → intent):
 * - empty.addRemoteProviderAction → show add-remote-provider form.
 * - empty.addLocalModelAction → show add-local-model form.
 * - addRemoteProvider.submitAction → `runConfigureProvider`.
 * - addRemoteProvider.cancelAction → return to configured/empty.
 * - addLocalModel.downloadAction → `runDownloadModel`.
 * - addLocalModel.cancelAction → `runCancelDownload`.
 * - providerList.addAction → show add-remote-provider form.
 * - providerList.removeAction → `runRemoveProvider`.
 * - modelList.activateReasoningAction → `runActivateModel { role: "reasoning" }`.
 * - modelList.activateEmbeddingAction → `runActivateModel { role: "embedding" }`.
 * - modelList.downloadAction → `runDownloadModel`.
 * - modelList.deleteAction → `runDeleteLocalModel`.
 * - roleSummary.deactivate{Reasoning,Embedding}Action → `runDeactivateModel`.
 *
 * Returns a cleanup that tears down every subscription.
 */
export function createAiConfigManager(
  workspace: Workspace,
  intents: Intents,
  view: AiConfigView,
): () => void {
  const [register, cleanup] = newRegistry();
  let providers: readonly ProviderDescriptor[] = [];
  let models: readonly ModelDescriptor[] = [];

  const refreshView = (): void => {
    view.providerList.setRows([...providers]);
    view.modelList.setRows([...models]);
    if (
      providers.length === 0 &&
      models.every((m) => m.runtime === "local" && m.status !== "ready")
    ) {
      view.showEmpty();
    } else {
      view.showConfigured();
    }
  };

  const reloadProviders = async (): Promise<void> => {
    providers = await runListProviders(intents, undefined).promise;
    refreshView();
  };

  const reloadModels = async (): Promise<void> => {
    models = await runListModels(intents, undefined).promise;
    refreshView();
  };

  // ── Subscribe to broadcasts ─────────────────────────────────────
  register(
    handleProvidersChanged(intents, (intent) => {
      providers = intent.payload;
      refreshView();
      void reloadModels(); // active flags may have changed via cascade
      intent.resolve();
      return false; // observer
    }),
  );

  register(
    handleActiveModelChanged(intents, (intent) => {
      void reloadModels();
      const reasoning = workspace.requireAdapter(ActiveReasoningModel);
      const embedding = workspace.requireAdapter(ActiveEmbeddingModel);
      view.roleSummary.setReasoning(labelForKey(reasoning.catalogKey, models));
      view.roleSummary.setEmbedding(labelForKey(embedding.catalogKey, models));
      intent.resolve();
      return false;
    }),
  );

  register(
    handleActivationProgress(intents, (intent) => {
      const { phase, progress, message, modelKey } = intent.payload;
      if (view.addLocalModel.modelPicker.selectedKey === modelKey) {
        if (phase === "downloading") {
          view.addLocalModel.setDownloading(message);
          if (progress !== undefined) view.addLocalModel.setProgress(progress, message);
        } else if (phase === "ready") {
          view.addLocalModel.setIdle(`${message} ✓`);
        } else if (phase === "error") {
          view.addLocalModel.setIdle(`Error: ${message}`);
        }
      }
      intent.resolve();
      return false;
    }),
  );

  // ── Action wiring ───────────────────────────────────────────────
  register(
    view.empty.addRemoteProviderAction.onSubmit(() => {
      view.showAddRemoteProvider();
    }),
  );
  register(
    view.empty.addLocalModelAction.onSubmit(() => {
      view.showAddLocalModel();
    }),
  );
  register(
    view.providerList.addAction.onSubmit(() => {
      view.showAddRemoteProvider();
    }),
  );

  register(
    view.addRemoteProvider.submitAction.onSubmit(() => {
      const providerName = view.addRemoteProvider.providerNameField.selectedKey as
        | ProviderName
        | undefined;
      const label = view.addRemoteProvider.labelField.value;
      if (!providerName || !label) return;
      const apiKey = view.addRemoteProvider.apiKeyField.value || undefined;
      const baseURL = view.addRemoteProvider.baseURLField.value || undefined;
      void runConfigureProvider(intents, {
        providerId: providerName,
        settings: { providerName, label, apiKey, baseURL },
      }).promise.then((result) => {
        if (result.ok) {
          view.addRemoteProvider.reset();
          refreshView();
        }
      });
    }),
  );
  register(
    view.addRemoteProvider.cancelAction.onSubmit(() => {
      view.addRemoteProvider.reset();
      refreshView();
    }),
  );

  register(
    view.addLocalModel.downloadAction.onSubmit(() => {
      const catalogKey = view.addLocalModel.modelPicker.selectedKey;
      if (!catalogKey) return;
      view.addLocalModel.setDownloading();
      void runDownloadModel(intents, { catalogKey }).promise.then(() => {
        void reloadModels();
      });
    }),
  );
  register(
    view.addLocalModel.cancelAction.onSubmit(() => {
      const catalogKey = view.addLocalModel.modelPicker.selectedKey;
      if (!catalogKey) return;
      void runCancelDownload(intents, { catalogKey }).promise;
    }),
  );
  register(
    view.addLocalModel.closeAction.onSubmit(() => {
      refreshView();
    }),
  );

  register(
    view.providerList.removeAction.onSubmit(() => {
      const row = view.providerList.removeAction.payload;
      if (!row) return;
      void runRemoveProvider(intents, {
        providerId: row.providerId,
        instanceId: row.instanceId,
      }).promise;
    }),
  );

  register(
    view.modelList.activateReasoningAction.onSubmit(() => {
      const row = view.modelList.activateReasoningAction.payload;
      if (!row) return;
      void runActivateModel(intents, {
        catalogKey: row.catalogKey,
        role: "reasoning",
      }).promise;
    }),
  );
  register(
    view.modelList.activateEmbeddingAction.onSubmit(() => {
      const row = view.modelList.activateEmbeddingAction.payload;
      if (!row) return;
      void runActivateModel(intents, {
        catalogKey: row.catalogKey,
        role: "embedding",
      }).promise;
    }),
  );
  register(
    view.modelList.downloadAction.onSubmit(() => {
      const row = view.modelList.downloadAction.payload;
      if (!row) return;
      void runDownloadModel(intents, { catalogKey: row.catalogKey }).promise;
    }),
  );
  register(
    view.modelList.deleteAction.onSubmit(() => {
      const row = view.modelList.deleteAction.payload;
      if (!row) return;
      void runDeleteLocalModel(intents, { catalogKey: row.catalogKey }).promise.then(() =>
        reloadModels(),
      );
    }),
  );

  register(
    view.roleSummary.deactivateReasoningAction.onSubmit(() => {
      void runDeactivateModel(intents, { role: "reasoning" }).promise;
    }),
  );
  register(
    view.roleSummary.deactivateEmbeddingAction.onSubmit(() => {
      void runDeactivateModel(intents, { role: "embedding" }).promise;
    }),
  );

  // Initial load — defer until the workspace is open because the
  // wrapped ModelManager builds its impl on workspace.onLoad. If the
  // workspace is already open, run immediately.
  const initialLoad = (): void => {
    void Promise.all([reloadProviders(), reloadModels()]).catch((err) => {
      console.error("[ai-config.manager] initial load failed:", err);
    });
  };
  if (workspace.isOpened) {
    initialLoad();
  } else {
    register(workspace.onLoad(initialLoad));
  }

  return cleanup;
}

function labelForKey(
  catalogKey: string | undefined,
  models: readonly ModelDescriptor[],
): string | undefined {
  if (!catalogKey) return undefined;
  const found = models.find((m) => m.catalogKey === catalogKey);
  return found?.label ?? catalogKey;
}
