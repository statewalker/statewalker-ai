import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { ModelConfig } from "@statewalker/ai-provider";
import type { Intents } from "@statewalker/shared-intents";
import { newRegistry } from "@statewalker/shared-registry";
import type { Workspace } from "@statewalker/workspace-api";
import { ActiveEmbeddingModel, ActiveReasoningModel, ModelManager } from "../../public/adapters.js";
import {
  handleActivateModel,
  handleDeactivateModel,
  handleGetActiveModel,
  handlePickModel,
  runActiveModelChanged,
} from "../../public/intents.js";
import type { ModelDescriptor, ModelRole } from "../../public/types.js";
import type { ActiveEmbeddingModelImpl, ActiveReasoningModelImpl } from "../adapters.impl.js";

function providerIdFor(config: ModelConfig): string {
  return config.runtime === "remote" ? config.provider : config.engine;
}

function descriptorFor(catalogKey: string, config: ModelConfig): ModelDescriptor {
  return {
    catalogKey,
    label: config.label,
    providerId: providerIdFor(config),
    instanceId: config.runtime === "remote" ? config.providerInstanceId : undefined,
    runtime: config.runtime,
    kinds: config.kinds ?? ["reasoning"],
    status: "ready",
    sizeBytes: config.runtime === "local" ? config.sizeBytes : undefined,
    contextWindow:
      config.runtime === "local" ? (config.ggufNCtx ?? config.mlcContextWindowSize) : undefined,
    isActiveReasoning: false,
    isActiveEmbedding: false,
  };
}

function setActiveForRole(
  workspace: Workspace,
  role: ModelRole,
  model: LanguageModelV3 | undefined,
  catalogKey: string | undefined,
  providerId: string | undefined,
): void {
  if (role === "reasoning") {
    const adapter = workspace.requireAdapter(ActiveReasoningModel) as ActiveReasoningModelImpl;
    adapter.setReasoning(model, catalogKey, providerId);
  } else {
    const adapter = workspace.requireAdapter(ActiveEmbeddingModel) as ActiveEmbeddingModelImpl;
    adapter.setEmbedding(model, catalogKey, providerId);
  }
}

function readActiveForRole(
  workspace: Workspace,
  role: ModelRole,
): {
  model: LanguageModelV3 | undefined;
  catalogKey: string | undefined;
  providerId: string | undefined;
} {
  const adapter =
    role === "reasoning"
      ? workspace.requireAdapter(ActiveReasoningModel)
      : workspace.requireAdapter(ActiveEmbeddingModel);
  return {
    model: adapter.model,
    catalogKey: adapter.catalogKey,
    providerId: adapter.providerId,
  };
}

export function registerActivationHandlers(workspace: Workspace, intents: Intents): () => void {
  const [register, cleanup] = newRegistry();

  register(
    handleActivateModel(intents, (intent) => {
      void (async () => {
        const { catalogKey, role } = intent.payload;
        try {
          const manager = workspace.requireAdapter(ModelManager).impl;
          const config = manager.store.catalog[catalogKey];
          if (!config) {
            intent.resolve({ ok: false, error: `Unknown catalogKey: ${catalogKey}` });
            return;
          }

          let activated: LanguageModelV3 | undefined;
          let lastError: Error | undefined;
          for await (const progress of manager.activate(catalogKey)) {
            if (progress.phase === "ready") {
              // The wrapped ModelManager stores the live model on the
              // ModelStateStore — read it back. Fall back to a typed
              // probe via deactivate-then-reactivate is unnecessary
              // because the generator yields once "ready".
              const state = manager.store.peekActiveModel?.(catalogKey);
              activated = (state as LanguageModelV3 | undefined) ?? undefined;
            } else if (progress.phase === "error") {
              lastError = progress.error ?? new Error(progress.message);
            }
          }

          if (lastError || !activated) {
            intent.resolve({
              ok: false,
              error: lastError?.message ?? "activation did not produce a model",
            });
            return;
          }

          const providerId = providerIdFor(config);
          setActiveForRole(workspace, role, activated, catalogKey, providerId);
          // Broadcast BEFORE resolve so awaiters see the broadcast already.
          runActiveModelChanged(intents, { role, catalogKey });
          intent.resolve({ ok: true });
        } catch (err) {
          intent.resolve({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
      return true;
    }),
  );

  register(
    handleDeactivateModel(intents, (intent) => {
      try {
        const { role } = intent.payload;
        const manager = workspace.requireAdapter(ModelManager).impl;
        const current = readActiveForRole(workspace, role);
        if (current.catalogKey) {
          try {
            manager.deactivate(current.catalogKey);
          } catch {
            // Deactivation in the wrapped manager is best-effort.
          }
        }
        setActiveForRole(workspace, role, undefined, undefined, undefined);
        runActiveModelChanged(intents, { role, catalogKey: undefined });
        intent.resolve();
      } catch (err) {
        intent.reject(err);
      }
      return true;
    }),
  );

  register(
    handleGetActiveModel(intents, (intent) => {
      try {
        const { role } = intent.payload;
        const { model, catalogKey } = readActiveForRole(workspace, role);
        if (!model || !catalogKey) {
          intent.resolve(undefined);
          return true;
        }
        const manager = workspace.requireAdapter(ModelManager).impl;
        const config = manager.store.catalog[catalogKey];
        const descriptor = config
          ? descriptorFor(catalogKey, config)
          : ({
              catalogKey,
              label: catalogKey,
              providerId: "",
              runtime: "remote",
              kinds: [role],
              status: "ready",
              isActiveReasoning: role === "reasoning",
              isActiveEmbedding: role === "embedding",
            } as ModelDescriptor);
        intent.resolve({ catalogKey, descriptor, model });
      } catch (err) {
        intent.reject(err);
      }
      return true;
    }),
  );

  register(
    handlePickModel(intents, (intent) => {
      // Picker UI lands in §9. Until then, the handler resolves with
      // `undefined` (treated as "no selection" — caller can fall back
      // to its own UI or to the configurator panel).
      intent.resolve(undefined);
      return true;
    }),
  );

  return cleanup;
}
