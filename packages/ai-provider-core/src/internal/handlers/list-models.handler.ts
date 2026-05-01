import type { ModelConfig, ModelKind } from "@statewalker/ai-provider";
import type { Intents } from "@statewalker/shared-intents";
import { newRegistry } from "@statewalker/shared-registry";
import type { Workspace } from "@statewalker/workspace-api";
import { ActiveEmbeddingModel, ActiveReasoningModel, ModelManager } from "../../public/adapters.js";
import { handleListModels } from "../../public/intents.js";
import type { ListModelsPayload, ModelDescriptor } from "../../public/types.js";

const DEFAULT_KINDS: ModelKind[] = ["reasoning"];

function effectiveKinds(config: ModelConfig): ModelKind[] {
  return config.kinds ?? DEFAULT_KINDS;
}

function providerIdFor(config: ModelConfig): string {
  return config.runtime === "remote" ? config.provider : config.engine;
}

function instanceIdFor(config: ModelConfig): string | undefined {
  return config.runtime === "remote" ? config.providerInstanceId : undefined;
}

function contextWindowFor(config: ModelConfig): number | undefined {
  if (config.runtime === "local") {
    return config.ggufNCtx ?? config.mlcContextWindowSize;
  }
  return undefined;
}

function sizeBytesFor(config: ModelConfig): number | undefined {
  return config.runtime === "local" ? config.sizeBytes : undefined;
}

function descriptorMatches(d: ModelDescriptor, filter: ListModelsPayload | undefined): boolean {
  if (!filter) return true;
  if (filter.runtime && d.runtime !== filter.runtime) return false;
  if (filter.role && !d.kinds.includes(filter.role)) return false;
  if (filter.providerId && d.providerId !== filter.providerId) return false;
  if (filter.instanceId && d.instanceId !== filter.instanceId) return false;
  if (filter.status && d.status !== filter.status) return false;
  return true;
}

export function registerListModelsHandlers(workspace: Workspace, intents: Intents): () => void {
  const [register, cleanup] = newRegistry();

  register(
    handleListModels(intents, (intent) => {
      try {
        const manager = workspace.requireAdapter(ModelManager).impl;
        const activeReasoning = workspace.requireAdapter(ActiveReasoningModel);
        const activeEmbedding = workspace.requireAdapter(ActiveEmbeddingModel);
        const reasoningKey = activeReasoning.catalogKey;
        const embeddingKey = activeEmbedding.catalogKey;

        const descriptors: ModelDescriptor[] = [];
        for (const [catalogKey, config] of Object.entries(manager.store.catalog)) {
          const state = manager.store.getState(catalogKey);
          descriptors.push({
            catalogKey,
            label: config.label,
            providerId: providerIdFor(config),
            instanceId: instanceIdFor(config),
            runtime: config.runtime,
            kinds: effectiveKinds(config),
            status: state?.status ?? "not-downloaded",
            sizeBytes: sizeBytesFor(config),
            contextWindow: contextWindowFor(config),
            isActiveReasoning: reasoningKey === catalogKey,
            isActiveEmbedding: embeddingKey === catalogKey,
          });
        }

        intent.resolve(descriptors.filter((d) => descriptorMatches(d, intent.payload)));
      } catch (err) {
        intent.reject(err);
      }
      return true;
    }),
  );

  return cleanup;
}
