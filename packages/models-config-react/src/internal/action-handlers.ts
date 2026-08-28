import type { StateStore } from "@json-render/core";
import {
  type Connection,
  type ConnectionType,
  listConnectionModels,
  Providers,
  type ProvidersConfig,
  SelectActiveModelCommand,
  validateConnectionUrl,
} from "@statewalker/ai-providers";
import { applyDefaultStarred, capabilitiesFor } from "@statewalker/models-config";

interface ModelRef {
  connectionId: string;
  modelId: string;
}

import { LocalModels, RefreshConnectionModelsCommand } from "@statewalker/models-config";
import { Commands } from "@statewalker/shared-commands";
import type { Workspace } from "@statewalker/workspace.core";

const newConnectionId = (): string =>
  `conn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

type Handler = (params: Record<string, unknown>) => Promise<void>;

export interface ActionHandlerContext {
  workspace: Workspace;
  store: StateStore;
}

interface ConnectionFormParams {
  id?: string;
  type: ConnectionType;
  name: string;
  url?: string;
  apiKey: string;
  headers?: { name: string; value: string }[];
}

/**
 * Build the action-handler map passed to `defineRegistry`. Closures
 * capture the workspace + store at construction; each handler reads
 * the latest persistent snapshot from `Providers.config` on every
 * call (no stale closures).
 */
export function buildActionHandlers(ctx: ActionHandlerContext): Record<string, Handler> {
  const { workspace, store } = ctx;
  const providers = workspace.requireAdapter(Providers);
  const localModels = workspace.requireAdapter(LocalModels);
  const commands = workspace.requireAdapter(Commands);

  function setUi(path: string, value: unknown): void {
    store.set(`/ui/${path}`, value);
  }
  function getUi<T>(path: string): T {
    return store.get(`/ui/${path}`) as T;
  }

  async function saveConnection(params: Record<string, unknown>): Promise<void> {
    const p = params as unknown as ConnectionFormParams;
    const current = providers.config;
    const existing = p.id ? current.connections.find((c) => c.id === p.id) : undefined;
    const next: Connection = {
      id: p.id ?? newConnectionId(),
      type: p.type,
      name: p.name,
      url: p.url || undefined,
      apiKey: p.apiKey,
      headers: p.headers && p.headers.length > 0 ? p.headers : undefined,
      starredModelIds: existing?.starredModelIds ?? [],
    };
    const connections = p.id
      ? current.connections.map((c) => (c.id === p.id ? { ...c, ...next, id: c.id } : c))
      : [...current.connections, next];
    const nextConfig: ProvidersConfig = { ...current, connections };
    await providers.saveProviders(nextConfig);
    setUi("connectionForm/editingId", undefined);
    setUi("connectionForm/type", "openai");
    setUi("connectionForm/name", "");
    setUi("connectionForm/url", "");
    setUi("connectionForm/apiKey", "");
    setUi("connectionForm/headers", []);
    setUi("connectionForm/error", undefined);
    // Implicit refresh — best-effort, surfaces errors via the form.
    try {
      await commands.call(RefreshConnectionModelsCommand, {
        connectionId: next.id,
      }).promise;
    } catch (err) {
      setUi("connectionForm/error", err instanceof Error ? err.message : String(err));
    }
  }

  async function removeConnection(params: Record<string, unknown>): Promise<void> {
    const { connectionId } = params as { connectionId: string };
    const current = providers.config;
    const connections = current.connections.filter((c) => c.id !== connectionId);
    const active = current.active.providerId === connectionId ? {} : current.active;
    await providers.saveProviders({ ...current, connections, active });
  }

  async function refreshConnection(params: Record<string, unknown>): Promise<void> {
    const { connectionId } = params as { connectionId: string };
    try {
      await commands.call(RefreshConnectionModelsCommand, { connectionId }).promise;
    } catch (err) {
      setUi("connectionForm/error", err instanceof Error ? err.message : String(err));
    }
  }

  function updateConnection(
    current: ProvidersConfig,
    connectionId: string,
    updater: (c: Connection) => Connection,
  ): ProvidersConfig {
    return {
      ...current,
      connections: current.connections.map((c) => (c.id === connectionId ? updater(c) : c)),
    };
  }

  async function starModel(params: Record<string, unknown>): Promise<void> {
    const { connectionId, modelId } = params as unknown as ModelRef;
    const current = providers.config;
    const next = updateConnection(current, connectionId, (c) =>
      c.starredModelIds.includes(modelId)
        ? c
        : { ...c, starredModelIds: [...c.starredModelIds, modelId] },
    );
    if (next === current) return;
    await providers.saveProviders(next);
  }

  async function unstarModel(params: Record<string, unknown>): Promise<void> {
    const { connectionId, modelId } = params as unknown as ModelRef;
    const current = providers.config;
    const next = updateConnection(current, connectionId, (c) => ({
      ...c,
      starredModelIds: c.starredModelIds.filter((id) => id !== modelId),
    }));
    await providers.saveProviders(next);
  }

  async function toggleStar(params: Record<string, unknown>): Promise<void> {
    const { connectionId, modelId } = params as unknown as ModelRef;
    const current = providers.config;
    const conn = current.connections.find((c) => c.id === connectionId);
    if (!conn) return;
    if (conn.starredModelIds.includes(modelId)) {
      await unstarModel(params);
    } else {
      await starModel(params);
    }
  }

  /**
   * Connect lifecycle action. Reads the form values for a new
   * Connection (or operates against an existing record's id), fetches
   * the provider's model list, persists the Connection with
   * `discoveredModels` + `discoveredAt`, and seeds `starredModelIds`
   * from the curated `DEFAULT_STARRED_BY_TYPE` table iff the
   * Connection's `starredModelIds` was empty immediately before this
   * call.
   */
  async function connectConnection(params: Record<string, unknown>): Promise<void> {
    const p = params as {
      connectionId?: string;
      connectionType?: ConnectionType;
    };
    const current = providers.config;
    const target = p.connectionId
      ? current.connections.find((c) => c.id === p.connectionId)
      : null;
    // For a fresh form submission, the spec passes `connectionType`
    // (the active type sub-tab is the Connection's type). Fall back
    // to /ui/activeType if the param is missing.
    const formType: ConnectionType =
      p.connectionType ?? (getUi<ConnectionType>("activeType") ?? "openai");
    const errorPath = `connectionForms/${formType}/error`;
    if (p.connectionId && !target) {
      setUi(errorPath, `Unknown connection: ${p.connectionId}`);
      return;
    }
    const formName = getUi<string>(`connectionForms/${formType}/name`) ?? "";
    const formApiKey = getUi<string>(`connectionForms/${formType}/apiKey`) ?? "";
    if (!target && !formApiKey.trim()) {
      setUi(errorPath, "API key is required");
      return;
    }
    const formUrl = getUi<string>(`connectionForms/${formType}/url`) ?? "";
    const formHeaders =
      getUi<Array<{ name: string; value: string }>>(`connectionForms/${formType}/headers`) ?? [];
    const conn: Connection = target ?? {
      id: newConnectionId(),
      type: formType,
      name: formName || `${formType} connection`,
      url: formUrl || undefined,
      apiKey: formApiKey,
      headers: formHeaders.length > 0 ? formHeaders : undefined,
      starredModelIds: [],
    };
    // Clear any prior error so the Alert hides while the request is in flight.
    setUi(errorPath, null);
    try {
      validateConnectionUrl(conn);
      // Step 1 — connect to the service and fetch the model list.
      // If this throws (auth, network, CORS, …) we surface the
      // error and DO NOT persist the connection.
      const discoveredModels = (await listConnectionModels(conn)).map((m) => ({
        ...m,
        capabilities: m.capabilities ?? capabilitiesFor(m.id),
      }));
      const seedStars = conn.starredModelIds.length === 0;
      const starredModelIds = seedStars
        ? applyDefaultStarred(
            conn.type,
            discoveredModels.map((m) => m.id),
          )
        : conn.starredModelIds;
      const updated: Connection = {
        ...conn,
        discoveredModels,
        discoveredAt: Date.now(),
        starredModelIds,
      };
      const connections = target
        ? current.connections.map((c) => (c.id === target.id ? updated : c))
        : [...current.connections, updated];
      // Step 2 — only AFTER discovery succeeds do we persist the
      // Connection (with the discovered models + default-starred
      // seed) into providers.json.
      await providers.saveProviders({ ...current, connections });
      if (!target) {
        // Form was for adding — clear the active type's form on
        // success so the user can add another connection for the
        // same provider without re-typing.
        setUi(`connectionForms/${formType}/name`, "");
        setUi(`connectionForms/${formType}/url`, "");
        setUi(`connectionForms/${formType}/apiKey`, "");
        setUi(`connectionForms/${formType}/headers`, []);
      }
    } catch (err) {
      setUi(errorPath, err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Check Connection lifecycle action. Re-fetches a connected
   * Connection's model list, preserves the user's existing
   * `starredModelIds`, and prunes star entries whose model ids are
   * no longer in the refreshed list. Does NOT re-apply the
   * default-starred table.
   */
  async function checkConnection(params: Record<string, unknown>): Promise<void> {
    const { connectionId } = params as { connectionId: string };
    const current = providers.config;
    const conn = current.connections.find((c) => c.id === connectionId);
    if (!conn) return;
    try {
      validateConnectionUrl(conn);
      const discoveredModels = (await listConnectionModels(conn)).map((m) => ({
        ...m,
        capabilities: m.capabilities ?? capabilitiesFor(m.id),
      }));
      const stillPresent = new Set(discoveredModels.map((m) => m.id));
      const updated: Connection = {
        ...conn,
        discoveredModels,
        discoveredAt: Date.now(),
        starredModelIds: conn.starredModelIds.filter((id) => stillPresent.has(id)),
      };
      const connections = current.connections.map((c) => (c.id === conn.id ? updated : c));
      await providers.saveProviders({ ...current, connections });
    } catch (err) {
      setUi(
        `connectionRows/${connectionId}/error`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Disconnect lifecycle action. Clears `apiKey`,
   * `discoveredModels`, `discoveredAt`, and `starredModelIds` in one
   * save. The shell record (id, type, name, url, headers) persists
   * so the user can re-Connect with one click.
   */
  async function disconnectConnection(params: Record<string, unknown>): Promise<void> {
    const { connectionId } = params as { connectionId: string };
    const current = providers.config;
    const updated = current.connections.map((c) =>
      c.id === connectionId
        ? {
            ...c,
            apiKey: "",
            discoveredModels: undefined,
            discoveredAt: undefined,
            starredModelIds: [],
          }
        : c,
    );
    await providers.saveProviders({ ...current, connections: updated });
  }

  async function selectModel(params: Record<string, unknown>): Promise<void> {
    const { connectionId, modelId } = params as unknown as ModelRef;
    await commands.call(SelectActiveModelCommand, {
      providerId: connectionId,
      modelId,
    }).promise;
    setUi("dialogs/modelsList/open", false);
  }

  async function downloadLocalModel(params: Record<string, unknown>): Promise<void> {
    const { key } = params as { key: string };
    try {
      for await (const progress of localModels.download(key)) {
        setUi(`downloads/${key}`, {
          phase: progress.phase,
          progress: progress.progress ?? 0,
          message: progress.message,
        });
      }
      // On completion, mark in providers.json.
      const current = providers.config;
      if (!current.local.downloaded.some((d) => d.key === key)) {
        await providers.saveProviders({
          ...current,
          local: {
            ...current.local,
            downloaded: [...current.local.downloaded, { key, downloadedAt: Date.now() }],
          },
        });
      }
    } catch (err) {
      setUi(`downloads/${key}/error`, err instanceof Error ? err.message : String(err));
    }
  }

  async function cancelDownload(params: Record<string, unknown>): Promise<void> {
    const { key } = params as { key: string };
    localModels.cancelDownload(key);
    setUi(`downloads/${key}`, undefined);
  }

  async function removeLocalModel(params: Record<string, unknown>): Promise<void> {
    const { key } = params as { key: string };
    await localModels.removeWeights(key);
    const current = providers.config;
    await providers.saveProviders({
      ...current,
      local: {
        ...current.local,
        downloaded: current.local.downloaded.filter((d) => d.key !== key),
      },
    });
  }

  async function openConnectionsDialog(): Promise<void> {
    setUi("dialogs/remoteConnections/open", true);
  }

  async function openLocalModelsDialog(): Promise<void> {
    setUi("dialogs/localModels/open", true);
  }

  async function closeDialog(params: Record<string, unknown>): Promise<void> {
    const { dialog } = params as {
      dialog: "modelsList" | "remoteConnections" | "localModels";
    };
    setUi(`dialogs/${dialog}/open`, false);
  }

  /** Per-type form state lives at `/ui/connectionForms/<type>/headers`.
   * `addHeader` / `removeHeader` operate on the active sub-tab's
   * headers array — read via `/ui/activeType` and routed accordingly. */
  function activeFormHeadersPath(): string {
    const type = getUi<ConnectionType>("activeType") ?? "openai";
    return `connectionForms/${type}/headers`;
  }

  async function addHeader(): Promise<void> {
    const path = activeFormHeadersPath();
    const existing = getUi<Array<{ name: string; value: string }>>(path) ?? [];
    setUi(path, [...existing, { name: "", value: "" }]);
  }

  async function removeHeader(params: Record<string, unknown>): Promise<void> {
    const { index } = params as { index: number };
    const path = activeFormHeadersPath();
    const existing = getUi<Array<{ name: string; value: string }>>(path) ?? [];
    setUi(path, existing.filter((_, i) => i !== index));
  }

  return {
    saveConnection,
    removeConnection,
    refreshConnection,
    connectConnection,
    checkConnection,
    disconnectConnection,
    starModel,
    unstarModel,
    toggleStar,
    selectModel,
    downloadLocalModel,
    cancelDownload,
    removeLocalModel,
    openConnectionsDialog,
    openLocalModelsDialog,
    closeDialog,
    addHeader,
    removeHeader,
  };
}
