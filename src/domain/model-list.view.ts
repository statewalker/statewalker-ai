import { BaseClass } from "@repo/shared/models";
import {
  type LocalModelConfig,
  type ModelConfig,
  type ModelState,
  modelKinds,
  type ProviderName,
  type RemoteModelConfig,
} from "@statewalker/ai-provider";
import type {
  ActiveModelsSet,
  ProviderSettings,
} from "../provider-settings-store.js";

/** One model row in the settings panel. */
export interface ModelRow {
  /** Catalog key. */
  key: string;
  /** Human-readable label. */
  label: string;
  /** Runtime (drives download-vs-activate affordances). */
  runtime: ModelConfig["runtime"];
  /** Current status. */
  status: ModelState["status"];
  /** Whether the model is currently active for reasoning. */
  activeForReasoning: boolean;
  /** Whether the model is currently active for embedding. */
  activeForEmbedding: boolean;
  /** Effective kinds (defaults to ["reasoning"]). */
  kinds: ("reasoning" | "embedding")[];
}

/** One group in the settings panel. */
export interface ModelGroup {
  /** Group id: canonical provider name or `{provider}:{instanceId}` for openai-compat. */
  id: string;
  /** Display name — capitalised provider name or user-supplied displayName. */
  label: string;
  /** Which provider this group belongs to. */
  provider: ProviderName | "local";
  /** The openai-compatible instance id, if any. */
  providerInstanceId?: string;
  /** Whether this provider has credentials configured. */
  configured: boolean;
  /** Rows inside this group, ordered by label. */
  rows: ModelRow[];
}

/** Derived view-model over ModelStateStore + ProviderSettingsStore. */
export class ModelListView extends BaseClass {
  #groups: ModelGroup[] = [];
  #activeReasoningKeys = new Set<string>();
  #activeEmbeddingKeys = new Set<string>();

  get groups(): ModelGroup[] {
    return this.#groups;
  }

  get activeReasoningKeys(): ReadonlySet<string> {
    return this.#activeReasoningKeys;
  }

  get activeEmbeddingKeys(): ReadonlySet<string> {
    return this.#activeEmbeddingKeys;
  }

  get hasActiveReasoning(): boolean {
    return this.#activeReasoningKeys.size > 0;
  }

  /**
   * Recompute from a snapshot of state. Called by the controller on every
   * store `onUpdate` event. Mutates internal fields and notifies listeners.
   */
  recompute(
    states: ReadonlyMap<string, ModelState>,
    providerSettings: ProviderSettings,
    activeModels: ActiveModelsSet,
  ): void {
    this.#activeReasoningKeys = new Set(
      activeModels.reasoning.filter((k) => states.get(k)?.status === "ready"),
    );
    this.#activeEmbeddingKeys = new Set(
      activeModels.embedding.filter((k) => states.get(k)?.status === "ready"),
    );
    this.#groups = buildGroups(
      states,
      providerSettings,
      this.#activeReasoningKeys,
      this.#activeEmbeddingKeys,
    );
    this.notify();
  }
}

function buildGroups(
  states: ReadonlyMap<string, ModelState>,
  providerSettings: ProviderSettings,
  activeReasoning: ReadonlySet<string>,
  activeEmbedding: ReadonlySet<string>,
): ModelGroup[] {
  const groupsById = new Map<string, ModelGroup>();

  for (const [key, state] of states) {
    const group = ensureGroup(groupsById, providerSettings, state.config);
    const kinds = modelKinds(state.config);
    group.rows.push({
      key,
      label: state.config.label,
      runtime: state.config.runtime,
      status: state.status,
      activeForReasoning: activeReasoning.has(key),
      activeForEmbedding: activeEmbedding.has(key),
      kinds,
    });
  }

  const groups = [...groupsById.values()];
  for (const g of groups) g.rows.sort((a, b) => a.label.localeCompare(b.label));
  // Canonical providers first (alphabetical), then custom oai-compat, then Local.
  groups.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
  return groups;
}

function rank(g: ModelGroup): number {
  if (g.provider === "local") return 2;
  if (g.provider === "openai-compatible") return 1;
  return 0;
}

function ensureGroup(
  groupsById: Map<string, ModelGroup>,
  providerSettings: ProviderSettings,
  config: ModelConfig,
): ModelGroup {
  if (config.runtime === "local") {
    return upsert(groupsById, "local", () => ({
      id: "local",
      label: "Local (in-browser)",
      provider: "local",
      configured: true,
      rows: [],
    }));
  }

  const remote = config as RemoteModelConfig;
  if (remote.provider === "openai-compatible") {
    const instanceId = remote.providerInstanceId ?? "default";
    const id = `openai-compatible:${instanceId}`;
    return upsert(groupsById, id, () => {
      const entry = providerSettings["openai-compatible"]?.[instanceId];
      return {
        id,
        label: entry?.displayName ?? instanceId,
        provider: "openai-compatible",
        providerInstanceId: instanceId,
        configured: Boolean(entry?.baseURL),
        rows: [],
      };
    });
  }

  const id = remote.provider;
  return upsert(groupsById, id, () => ({
    id,
    label: capitalise(remote.provider),
    provider: remote.provider,
    configured: Boolean(providerSettings[remote.provider]?.apiKey),
    rows: [],
  }));
}

function upsert<V>(map: Map<string, V>, key: string, factory: () => V): V {
  const existing = map.get(key);
  if (existing) return existing;
  const created = factory();
  map.set(key, created);
  return created;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Avoid accidental tree-shaking of `LocalModelConfig` symbol if needed later.
export type { LocalModelConfig };
