import type { StateStore } from "@json-render/core";
import type { Capability, Providers, ProvidersConfig } from "@statewalker/ai-providers";
import { capabilitiesFor, type LocalModels } from "@statewalker/models-config";

/**
 * A flattened model row — one per (connection, model) pair across
 * every Connection's `discoveredModels`. The spec's Models List
 * `repeat` iterates this array directly.
 */
export interface ModelRow {
  connectionId: string;
  connectionName: string;
  connectionType: string;
  modelId: string;
  label: string;
  capabilities: Capability[];
  starred: boolean;
  active: boolean;
}

/**
 * A flattened local-model row for the Local Models dialog. Combines
 * the curated catalog entry with the current download status.
 */
export interface LocalModelRow {
  key: string;
  modelId: string;
  label: string;
  family: string;
  size: string;
  description: string;
  status: string;
  downloaded: boolean;
  active: boolean;
}

interface PersistentSnapshot {
  connections: ProvidersConfig["connections"];
  local: ProvidersConfig["local"];
  active: ProvidersConfig["active"];
  allModels: ModelRow[];
  localModelsList: LocalModelRow[];
}

function flattenModels(config: ProvidersConfig): ModelRow[] {
  const keyOf = (cid: string, mid: string) => `${cid}::${mid}`;
  const activeKey =
    config.active.providerId && config.active.modelId
      ? keyOf(config.active.providerId, config.active.modelId)
      : null;
  const out: ModelRow[] = [];
  for (const c of config.connections) {
    const starredSet = new Set(c.starredModelIds);
    for (const m of c.discoveredModels ?? []) {
      out.push({
        connectionId: c.id,
        connectionName: c.name,
        connectionType: c.type,
        modelId: m.id,
        label: m.label,
        capabilities: m.capabilities ?? capabilitiesFor(m.id),
        starred: starredSet.has(m.id),
        active: activeKey === keyOf(c.id, m.id),
      });
    }
  }
  return out;
}

function flattenLocalModels(config: ProvidersConfig, localModels: LocalModels): LocalModelRow[] {
  const downloadedSet = new Set(config.local.downloaded.map((d) => d.key));
  const activeLocalKey = config.active.providerId === "local" ? config.active.modelId : null;
  return localModels.list().map((entry) => {
    // Catalog key (`local:smollm2-360m`) is the lookup id; we don't
    // have direct access to it from the entry, but the catalog
    // exposes it as the record key — see local-catalog.ts.
    const key = `local:${entry.modelId.split("/").pop()?.toLowerCase() ?? entry.modelId}`;
    const status = localModels.status(key);
    return {
      key,
      modelId: entry.modelId,
      label: entry.label,
      family: entry.family,
      size: entry.size,
      description: entry.description,
      status,
      downloaded: downloadedSet.has(key) || status === "downloaded" || status === "ready",
      active: activeLocalKey === key,
    };
  });
}

/** Project the workspace adapters into `/persistent/*` paths. */
function snapshot(providers: Providers, localModels: LocalModels): PersistentSnapshot {
  const config = providers.config;
  return {
    connections: config.connections,
    local: config.local,
    active: config.active,
    allModels: flattenModels(config),
    localModelsList: flattenLocalModels(config, localModels),
  };
}

/** Push the snapshot's fields into the state store's `/persistent/*` paths. */
function applySnapshot(store: StateStore, snap: PersistentSnapshot): void {
  store.update({
    "/persistent/connections": snap.connections,
    "/persistent/local": snap.local,
    "/persistent/active": snap.active,
    "/persistent/allModels": snap.allModels,
    "/persistent/localModelsList": snap.localModelsList,
  });
}

/**
 * Subscribe the json-render `StateStore` to `Providers` and
 * `LocalModels` notifications. Returns a single combined disposer.
 * Seeds the store with the current snapshot synchronously before
 * returning.
 *
 * Used by the transitional overlay host. The new Settings tab hosts
 * use the focused `bindLocalModels` helper below (the Connections
 * tab projects its own per-type view directly inside the component).
 */
export function bindPersistent(
  store: StateStore,
  providers: Providers,
  localModels: LocalModels,
): () => void {
  applySnapshot(store, snapshot(providers, localModels));
  const off1 = providers.onUpdate(() => {
    applySnapshot(store, snapshot(providers, localModels));
  });
  const off2 = localModels.onUpdate(() => {
    applySnapshot(store, snapshot(providers, localModels));
  });
  return () => {
    off1();
    off2();
  };
}

/** Local-models-only bridge for the Settings "Local Models" tab.
 * Mirrors `/persistent/localModelsList` from the curated catalog +
 * `Providers.config.local.downloaded` + `LocalModels` status. */
export function bindLocalModels(
  store: StateStore,
  providers: Providers,
  localModels: LocalModels,
): () => void {
  const push = () => {
    store.update({
      "/persistent/localModelsList": flattenLocalModels(providers.config, localModels),
    });
  };
  push();
  const off1 = providers.onUpdate(push);
  const off2 = localModels.onUpdate(push);
  return () => {
    off1();
    off2();
  };
}
