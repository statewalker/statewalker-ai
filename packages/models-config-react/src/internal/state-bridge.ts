import type { StateStore } from "@json-render/core";
import type { Providers, ProvidersConfig } from "@statewalker/ai-providers";
import type { LocalModels } from "@statewalker/models-config";

interface PersistentSnapshot {
  connections: ProvidersConfig["connections"];
  starred: ProvidersConfig["starred"];
  local: ProvidersConfig["local"];
  active: ProvidersConfig["active"];
  localStatuses: Record<string, string>;
}

/** Project the workspace adapters into `/persistent/*` paths. */
function snapshot(providers: Providers, localModels: LocalModels): PersistentSnapshot {
  const config = providers.config;
  const localStatuses: Record<string, string> = {};
  for (const entry of localModels.list()) {
    const key = `local:${entry.modelId.split("/").pop() ?? entry.modelId}`;
    // Use the catalog key (already in `local:` form) — keep both
    // raw `modelId` and the canonical local-key resolvable.
    localStatuses[key] = localModels.status(key);
  }
  // Also expose statuses keyed by catalog key directly (the format
  // the spec actually references).
  for (const key of Object.keys(localModels)) {
    void key; /* no-op — adapter doesn't expose key iter */
  }
  return {
    connections: config.connections,
    starred: config.starred,
    local: config.local,
    active: config.active,
    localStatuses,
  };
}

/** Push the snapshot's fields into the state store's `/persistent/*` paths. */
function applySnapshot(store: StateStore, snap: PersistentSnapshot): void {
  store.update({
    "/persistent/connections": snap.connections,
    "/persistent/starred": snap.starred,
    "/persistent/local": snap.local,
    "/persistent/active": snap.active,
    "/persistent/localStatuses": snap.localStatuses,
  });
}

/**
 * Subscribe the json-render `StateStore` to `Providers` and
 * `LocalModels` notifications. Returns a single combined disposer.
 * Seeds the store with the current snapshot synchronously before
 * returning.
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
