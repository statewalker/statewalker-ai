import { BaseClass } from "@statewalker/shared-baseclass";
import { emptyProvidersConfig, type ProvidersConfig } from "../public/providers-store.js";

/**
 * Workspace-adapter exposing the loaded `ProvidersConfig` reactively.
 * Mutates only via the manager (`internal/providers.manager.ts`):
 *  - `_setConfig(next)` is called after a successful load / save.
 *  - `notify()` fires; React consumers using
 *    `useAdapter(Providers)` + `useSyncExternalStore` re-render.
 *
 * `saveProviders` and `reload` are async wrappers around the
 * manager. Held on the adapter so React callers can fire them
 * directly without going through an intent (these are local-only
 * effects that don't benefit from cross-fragment dispatch).
 */
export class Providers extends BaseClass {
  /** Type-only declaration for `WorkspaceAdapter` weak-shape compat. */
  declare close?: () => void | Promise<void>;

  private _config: ProvidersConfig = emptyProvidersConfig;
  private _systemFolder = ".settings";
  private _saveProviders: (next: ProvidersConfig) => Promise<void> = async () => {
    /* attached by the manager on construction */
  };
  private _reload: () => Promise<void> = async () => {
    /* attached by the manager on construction */
  };

  get config(): ProvidersConfig {
    return this._config;
  }

  get systemFolder(): string {
    return this._systemFolder;
  }

  saveProviders(next: ProvidersConfig): Promise<void> {
    return this._saveProviders(next);
  }

  reload(): Promise<void> {
    return this._reload();
  }

  /** Manager-only: replace the snapshot and notify subscribers. */
  _setConfig(next: ProvidersConfig): void {
    this._config = next;
    this.notify();
  }

  /** Manager-only: set the system folder used for providers.json. */
  _setSystemFolder(folder: string): void {
    this._systemFolder = folder;
  }

  /** Manager-only: install the save/reload handlers. */
  _attach(handlers: {
    saveProviders: (next: ProvidersConfig) => Promise<void>;
    reload: () => Promise<void>;
  }): void {
    this._saveProviders = handlers.saveProviders;
    this._reload = handlers.reload;
  }
}
