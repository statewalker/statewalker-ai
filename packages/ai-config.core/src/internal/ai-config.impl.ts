import type { ProviderV3 } from "@ai-sdk/provider";
import { Secrets, type Workspace } from "@statewalker/workspace.core";
import { AiConfig, apiKeySecretKey } from "../public/ai-config.js";
import {
  type ActiveSelection,
  type AiConfigData,
  type Capability,
  type Connection,
  type DiscoveredModel,
  emptyAiConfigData,
} from "../public/types.js";
import { capabilitiesFor } from "./capabilities.js";
import { listConnectionModels } from "./discovery.js";
import { buildProvider } from "./provider-build.js";
import { loadAiConfig, saveAiConfig } from "./store.js";

export interface AiConfigImplOptions {
  systemFolder?: string;
}

/**
 * Concrete `AiConfig`: holds the single in-memory config state, persists it
 * credential-free via the store, and routes all credentials through `Secrets`.
 * Built per workspace; `load()` is called on workspace open (and lifts any
 * legacy plaintext key into `Secrets` once).
 */
export class AiConfigImpl extends AiConfig {
  private readonly workspace: Workspace;
  private readonly systemFolder: string;
  private _data: AiConfigData = structuredClone(emptyAiConfigData);
  private readonly _listeners = new Set<() => void>();

  constructor(workspace: Workspace, opts: AiConfigImplOptions = {}) {
    super();
    this.workspace = workspace;
    this.systemFolder = opts.systemFolder ?? ".settings";
  }

  private get secrets(): Secrets {
    return this.workspace.requireAdapter(Secrets);
  }

  async load(): Promise<void> {
    let migrated = false;
    this._data = await loadAiConfig(this.workspace.files, this.systemFolder, (id, key) => {
      void this.secrets.set(apiKeySecretKey(id), key);
      migrated = true;
    });
    // Persisting the stripped config makes the key-migration idempotent.
    if (migrated) await saveAiConfig(this.workspace.files, this.systemFolder, this._data);
    this._notify();
  }

  // ── reads ──────────────────────────────────────────────────────
  listConnections(): Connection[] {
    return this._data.connections;
  }
  getConnection(id: string): Connection | undefined {
    return this._data.connections.find((c) => c.id === id);
  }
  getActive(): ActiveSelection {
    return this._data.active;
  }
  async hasKey(connectionId: string): Promise<boolean> {
    const key = await this.secrets.get(apiKeySecretKey(connectionId));
    return typeof key === "string" && key.length > 0;
  }
  async getApiKey(connectionId: string): Promise<string> {
    const key = await this.secrets.get(apiKeySecretKey(connectionId));
    return typeof key === "string" ? key : "";
  }
  getModels(connectionId: string, capability?: Capability): DiscoveredModel[] {
    const models = this.getConnection(connectionId)?.discoveredModels ?? [];
    if (!capability) return models;
    // Fall back to id-based inference (mirrors the view layer) when a discovered model
    // carries no persisted capability tags — so e.g. `text-embedding-*` is recognised as
    // embedding-capable even if it was discovered before tagging existed.
    return models.filter((m) => (m.capabilities ?? capabilitiesFor(m.id)).includes(capability));
  }
  async getProvider(connectionId: string): Promise<ProviderV3> {
    const c = this.getConnection(connectionId);
    if (!c) throw new Error(`AiConfig: no connection "${connectionId}"`);
    const key = (await this.secrets.get(apiKeySecretKey(connectionId))) as string | undefined;
    return buildProvider(c.type, { apiKey: key ?? "", baseURL: c.url, headers: c.headers });
  }
  onUpdate(cb: () => void): () => void {
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }

  // ── writes ─────────────────────────────────────────────────────
  async upsertConnection(
    connection: Omit<Connection, "discoveredModels" | "discoveredAt">,
    apiKey?: string,
  ): Promise<void> {
    const existing = this.getConnection(connection.id);
    const merged: Connection = {
      ...connection,
      discoveredModels: existing?.discoveredModels,
      discoveredAt: existing?.discoveredAt,
      starredModelIds: connection.starredModelIds ?? existing?.starredModelIds ?? [],
    };
    this._data.connections = [
      ...this._data.connections.filter((c) => c.id !== connection.id),
      merged,
    ];
    if (apiKey !== undefined) await this.secrets.set(apiKeySecretKey(connection.id), apiKey);
    await this._persist();
  }

  async removeConnection(id: string): Promise<void> {
    this._data.connections = this._data.connections.filter((c) => c.id !== id);
    await this.secrets.delete(apiKeySecretKey(id));
    if (this._data.active.connectionId === id) this._data.active = {};
    await this._persist();
  }

  async setApiKey(connectionId: string, apiKey: string): Promise<void> {
    await this.secrets.set(apiKeySecretKey(connectionId), apiKey);
    this._notify();
  }

  async disconnect(connectionId: string): Promise<void> {
    const c = this.getConnection(connectionId);
    if (!c) return;
    await this.secrets.delete(apiKeySecretKey(connectionId));
    this.patchConnection(connectionId, {
      discoveredModels: undefined,
      discoveredAt: undefined,
      starredModelIds: [],
    });
    await this._persist();
  }

  async refreshModels(connectionId: string): Promise<DiscoveredModel[]> {
    const c = this.getConnection(connectionId);
    if (!c) throw new Error(`AiConfig: no connection "${connectionId}"`);
    const key = (await this.secrets.get(apiKeySecretKey(connectionId))) as string | undefined;
    const models = await listConnectionModels(c, key ?? "");
    // Prune stars that no longer correspond to a discovered model — drops stale
    // entries and any corruption (e.g. paths from a mis-resolved `$item` param).
    const discovered = new Set(models.map((m) => m.id));
    this.patchConnection(connectionId, {
      discoveredModels: models,
      discoveredAt: Date.now(),
      starredModelIds: c.starredModelIds.filter((id) => discovered.has(id)),
    });
    await this._persist();
    return models;
  }

  async setActive(connectionId: string, modelId: string): Promise<void> {
    this._data.active = { connectionId, modelId };
    await this._persist();
  }

  async starModels(connectionId: string, modelIds: string[]): Promise<void> {
    if (!this.getConnection(connectionId)) return;
    this.patchConnection(connectionId, { starredModelIds: modelIds });
    await this._persist();
  }

  // ── internals ──────────────────────────────────────────────────
  /** Replace one connection with an updated copy in a NEW `connections` array, so
   * reactive `listConnections()` readers (`useSyncExternalStore`, which compares the
   * snapshot by reference) observe the change. In-place mutation would notify but
   * leave the array reference unchanged, so the chat model picker would not refresh. */
  private patchConnection(id: string, patch: Partial<Connection>): void {
    this._data.connections = this._data.connections.map((c) =>
      c.id === id ? { ...c, ...patch } : c,
    );
  }

  private async _persist(): Promise<void> {
    await saveAiConfig(this.workspace.files, this.systemFolder, this._data);
    this._notify();
  }
  private _notify(): void {
    for (const l of this._listeners) l();
  }
}
