import type { StateStore } from "@json-render/core";
import {
  type Connection,
  type ConnectionType,
  Providers,
  type ProvidersConfig,
  SelectActiveModelCommand,
  type StarredRef,
} from "@statewalker/ai-providers";
import { LocalModels, RefreshConnectionModelsCommand } from "@statewalker/models-config";
import { Commands } from "@statewalker/shared-commands";
import type { Workspace } from "@statewalker/workspace";

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
    const next: Connection = {
      id: p.id ?? newConnectionId(),
      type: p.type,
      name: p.name,
      url: p.url || undefined,
      apiKey: p.apiKey,
      headers: p.headers && p.headers.length > 0 ? p.headers : undefined,
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
    const starred = current.starred.filter((s) => s.connectionId !== connectionId);
    const active = current.active.providerId === connectionId ? {} : current.active;
    await providers.saveProviders({
      ...current,
      connections,
      starred,
      active,
    });
  }

  async function refreshConnection(params: Record<string, unknown>): Promise<void> {
    const { connectionId } = params as { connectionId: string };
    try {
      await commands.call(RefreshConnectionModelsCommand, { connectionId }).promise;
    } catch (err) {
      setUi("connectionForm/error", err instanceof Error ? err.message : String(err));
    }
  }

  async function starModel(params: Record<string, unknown>): Promise<void> {
    const { connectionId, modelId } = params as unknown as StarredRef;
    const current = providers.config;
    if (current.starred.some((s) => s.connectionId === connectionId && s.modelId === modelId)) {
      return;
    }
    await providers.saveProviders({
      ...current,
      starred: [...current.starred, { connectionId, modelId }],
    });
  }

  async function unstarModel(params: Record<string, unknown>): Promise<void> {
    const { connectionId, modelId } = params as unknown as StarredRef;
    const current = providers.config;
    await providers.saveProviders({
      ...current,
      starred: current.starred.filter(
        (s) => !(s.connectionId === connectionId && s.modelId === modelId),
      ),
    });
  }

  async function selectModel(params: Record<string, unknown>): Promise<void> {
    const { connectionId, modelId } = params as unknown as StarredRef;
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

  async function addHeader(): Promise<void> {
    const existing = getUi<Array<{ name: string; value: string }>>("connectionForm/headers");
    setUi("connectionForm/headers", [...existing, { name: "", value: "" }]);
  }

  async function removeHeader(params: Record<string, unknown>): Promise<void> {
    const { index } = params as { index: number };
    const existing = getUi<Array<{ name: string; value: string }>>("connectionForm/headers");
    setUi(
      "connectionForm/headers",
      existing.filter((_, i) => i !== index),
    );
  }

  return {
    saveConnection,
    removeConnection,
    refreshConnection,
    starModel,
    unstarModel,
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
