import type { ProviderV3 } from "@ai-sdk/provider";
import {
  type ActivationProgress,
  ModelManager,
  ModelStateStore,
  type ModelStatus,
} from "@statewalker/ai-agent/models";
import { registerLocalProvider } from "@statewalker/ai-provider-browser/transformers";
import { BaseClass } from "@statewalker/shared-baseclass";
import type { FilesApi } from "@statewalker/webrun-files";
import { type LocalModelEntry, localCatalog } from "../internal/local-catalog.js";

export interface LocalModelsOptions {
  /** FilesApi used for weight storage (workspace.files). */
  files: FilesApi;
  /** Storage base path; defaults to `"/.settings/models/tjs"`. */
  basePath?: string;
}

/**
 * Workspace-scoped adapter wrapping a `ModelManager` configured with
 * the transformers.js engine and the fragment-local catalog. Surfaces
 * the lifecycle methods the action handlers call (`download`,
 * `cancelDownload`, `removeWeights`) and the `ProviderV3` factory the
 * `ActiveModel` value points at for `kind: "local"`.
 *
 * `BaseClass.notify()` fires on every status change so the
 * renderer-side state bridge can mirror `local.downloaded` / status
 * into the json-render `StateStore`.
 */
export class LocalModels extends BaseClass {
  declare init?: () => void | Promise<void>;
  declare close?: () => void | Promise<void>;

  private readonly _store: ModelStateStore;
  private readonly _manager: ModelManager;

  constructor(opts: LocalModelsOptions) {
    super();
    this._store = new ModelStateStore({ ...localCatalog });
    this._manager = new ModelManager({
      store: this._store,
      files: opts.files,
      modelStoragePath: opts.basePath ?? "/.settings/models",
    });
    registerLocalProvider(this._manager);
    // Listen to underlying store updates and re-broadcast.
    this._store.onUpdate(() => this.notify());
    // Best-effort scan of on-disk weights so previously-downloaded
    // models surface as "downloaded" immediately after workspace
    // open.
    void this._manager.refreshLocalStatuses();
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
   * Download weights for a local model. Yields progress events. The
   * caller is expected to also persist the resulting downloaded set
   * into `Providers.config.local.downloaded` via `saveProviders`.
   */
  download(key: string, signal?: AbortSignal): AsyncGenerator<ActivationProgress> {
    return this._manager.download(key, signal);
  }

  /** Abort an in-progress download. The download iterator terminates
   * with the abort error; the underlying state moves to `partial`. */
  cancelDownload(key: string): void {
    this._manager.cancel(key);
  }

  /** Delete the on-disk weights for a downloaded local model. */
  removeWeights(key: string): Promise<void> {
    return this._manager.deleteLocal(key);
  }

  /**
   * The `ProviderV3` face used by `ActiveModelValue.createProvider`
   * for `kind: "local"`. Calling `provider.languageModel(modelId)`
   * triggers `ModelManager.activate(modelId)` lazily (loads ONNX
   * weights into memory on first use; reuses thereafter).
   *
   * Note: this returns the underlying `ModelStateStore` directly;
   * the store implements `ProviderV3` and performs the lazy
   * activation in `languageModel`.
   */
  buildProvider(_modelKey: string): ProviderV3 {
    return this._store;
  }

  /** Underlying manager. Exposed for the lazy-activation flow when
   * `agent-runtime` rebuilds and needs to activate the chosen key. */
  get manager(): ModelManager {
    return this._manager;
  }
}
