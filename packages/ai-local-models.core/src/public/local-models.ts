import type { ProviderV3 } from "@ai-sdk/provider";
import {
  type ActivationProgress,
  ModelManager,
  ModelStateStore,
  type ModelStatus,
} from "@statewalker/ai-agent.core/models";
import { registerLocalProvider } from "@statewalker/ai-local-models.browser/transformers";
import { BaseClass } from "@statewalker/shared-baseclass";
import type { FilesApi } from "@statewalker/webrun-files";
import { type LocalModelEntry, localCatalog } from "../internal/local-catalog.js";
import {
  emptyLocalModelsConfig,
  type LocalModelsConfig,
  loadLocalModelsConfig,
  saveLocalModelsConfig,
} from "../internal/store.js";

export interface LocalModelsOptions {
  /** FilesApi used for weight storage + the config store (workspace.files). */
  files: FilesApi;
  /** Workspace system folder for `local-models.json`; defaults to `".settings"`. */
  systemFolder?: string;
  /** Weight storage base path; defaults to `"/.settings/models"`. */
  basePath?: string;
}

/**
 * Workspace-scoped adapter for the local-model domain. Wraps a
 * `ModelManager` configured with the transformers.js engine and the
 * curated catalog, AND owns the domain's own persistence
 * (`local-models.json`: the downloaded set + the active local key).
 *
 * `BaseClass.notify()` fires on every status change (manager) and every
 * config write so the renderer-side state bridge can mirror
 * `downloaded` / `active` / status into the json-render `StateStore`.
 */
export class LocalModels extends BaseClass {
  declare init?: () => void | Promise<void>;
  declare close?: () => void | Promise<void>;

  private readonly _files: FilesApi;
  private readonly _systemFolder: string;
  private readonly _store: ModelStateStore;
  private readonly _manager: ModelManager;
  private _config: LocalModelsConfig = { ...emptyLocalModelsConfig };

  constructor(opts: LocalModelsOptions) {
    super();
    this._files = opts.files;
    this._systemFolder = opts.systemFolder ?? ".settings";
    this._store = new ModelStateStore({ ...localCatalog });
    this._manager = new ModelManager({
      store: this._store,
      files: opts.files,
      modelStoragePath: opts.basePath ?? "/.settings/models",
    });
    registerLocalProvider(this._manager);
    // Listen to underlying store updates and re-broadcast.
    this._store.onUpdate(() => this.notify());
  }

  /** Persisted config (downloaded set + active local key). */
  get config(): LocalModelsConfig {
    return this._config;
  }

  /**
   * Load the persisted config (one-time migration from `providers.json`)
   * and scan on-disk weights so previously-downloaded models surface as
   * "downloaded" immediately. Safe to call once the workspace is open.
   */
  async load(): Promise<void> {
    this._config = await loadLocalModelsConfig(this._files, this._systemFolder);
    this.notify();
    await this._manager.refreshLocalStatuses();
  }

  /** All catalog entries available for download. */
  list(): readonly LocalModelEntry[] {
    return Object.values(localCatalog);
  }

  /** Current status for a catalog key. */
  status(key: string): ModelStatus {
    return this._store.getState(key)?.status ?? "not-downloaded";
  }

  /**
   * Download weights for a local model. Yields progress events. On
   * completion the caller should call `markDownloaded(key)`.
   */
  download(key: string, signal?: AbortSignal): AsyncGenerator<ActivationProgress> {
    return this._manager.download(key, signal);
  }

  /** Abort an in-progress download. The download iterator terminates
   * with the abort error; the underlying state moves to `partial`. */
  cancelDownload(key: string): void {
    this._manager.cancel(key);
  }

  /** Delete the on-disk weights for a downloaded local model and drop
   * it from the persisted downloaded set. */
  async removeWeights(key: string): Promise<void> {
    await this._manager.deleteLocal(key);
    await this.markRemoved(key);
  }

  /** Record a completed download in the persisted config (idempotent). */
  async markDownloaded(key: string): Promise<void> {
    if (this._config.downloaded.some((d) => d.key === key)) return;
    this._config = {
      ...this._config,
      downloaded: [...this._config.downloaded, { key, downloadedAt: Date.now() }],
    };
    await this._persist();
  }

  /** Drop a download record from the persisted config. */
  async markRemoved(key: string): Promise<void> {
    this._config = {
      ...this._config,
      downloaded: this._config.downloaded.filter((d) => d.key !== key),
    };
    await this._persist();
  }

  /** Persist the active local-model key (or clear it). */
  async setActiveKey(key: string | undefined): Promise<void> {
    if (this._config.active === key) return;
    this._config = { ...this._config, active: key };
    await this._persist();
  }

  /**
   * The `ProviderV3` face used by `ActiveModelValue.createProvider` for
   * `kind: "local"`. Calling `provider.languageModel(modelId)` triggers
   * lazy activation (loads ONNX weights into memory on first use).
   */
  buildProvider(_modelKey: string): ProviderV3 {
    return this._store;
  }

  /** Underlying manager. Exposed for the lazy-activation flow when
   * `agent-runtime` rebuilds and needs to activate the chosen key. */
  get manager(): ModelManager {
    return this._manager;
  }

  private async _persist(): Promise<void> {
    this.notify();
    try {
      await saveLocalModelsConfig(this._files, this._systemFolder, this._config);
    } catch {
      /* best-effort persistence */
    }
  }
}
