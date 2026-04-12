import type { LanguageModelV3 } from "@ai-sdk/provider";
import type {
  ModelConfig,
  ModelState,
  ModelStatus,
  ProviderName,
  RemoteProviderSettings,
} from "./types.js";

/**
 * Observable data model for model catalog, states, and active model instances.
 * Pure state container — no external API calls, no I/O.
 * Controllers subscribe via `onUpdate()` to react to state changes.
 */
export class ModelStateStore {
  private readonly _catalog: Record<string, ModelConfig>;
  private readonly _states = new Map<string, ModelState>();
  private readonly _activeModels = new Map<string, LanguageModelV3>();
  private readonly _providerSettings = new Map<
    ProviderName,
    RemoteProviderSettings
  >();
  private _activeModelKey = "";
  private _activeModelLabel = "";
  private readonly _listeners = new Set<() => void>();

  constructor(catalog: Record<string, ModelConfig>) {
    this._catalog = catalog;
    for (const [key, config] of Object.entries(catalog)) {
      this._states.set(key, {
        config,
        status:
          config.runtime === "local" ? "not-downloaded" : "not-downloaded",
      });
    }
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  onUpdate(cb: () => void): () => void {
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }

  /** Notify all subscribers of a state change. */
  notify(): void {
    for (const cb of this._listeners) cb();
  }

  /** The full model catalog. */
  get catalog(): Record<string, ModelConfig> {
    return this._catalog;
  }

  // ── Provider settings ─────────────────────────────────────────────────

  /** Get settings for a specific provider. */
  getProviderSettings(
    provider: ProviderName,
  ): RemoteProviderSettings | undefined {
    return this._providerSettings.get(provider);
  }

  /** Get all provider settings. */
  get providerSettings(): ReadonlyMap<ProviderName, RemoteProviderSettings> {
    return this._providerSettings;
  }

  /** Whether any provider has an API key configured. */
  get hasConfiguredProvider(): boolean {
    for (const s of this._providerSettings.values()) {
      if (s.apiKey) return true;
    }
    return false;
  }

  /** Set settings for a provider. Notifies listeners. */
  setProviderSettings(
    provider: ProviderName,
    settings: RemoteProviderSettings,
  ): void {
    this._providerSettings.set(provider, settings);
    this.notify();
  }

  /** Remove settings for a provider. Notifies listeners. */
  removeProviderSettings(provider: ProviderName): void {
    if (this._providerSettings.delete(provider)) {
      this.notify();
    }
  }

  // ── Active model key ──────────────────────────────────────────────────

  get activeModelKey(): string {
    return this._activeModelKey;
  }

  get activeModelLabel(): string {
    return this._activeModelLabel;
  }

  setActiveModelKey(key: string, label: string): void {
    if (this._activeModelKey === key && this._activeModelLabel === label)
      return;
    this._activeModelKey = key;
    this._activeModelLabel = label;
    this.notify();
  }

  /** Get a snapshot of all model states. */
  getStates(): Map<string, ModelState> {
    return new Map(this._states);
  }

  /** Get the state of a specific model. */
  getState(key: string): ModelState | undefined {
    return this._states.get(key);
  }

  /** Update the status of a model. Notifies listeners. */
  setStatus(key: string, status: ModelStatus, error?: Error): void {
    const existing = this._states.get(key);
    if (existing) {
      existing.status = status;
      existing.error = error;
      this.notify();
    }
  }

  /** Store an active (ready) model instance. Notifies listeners. */
  setActiveModel(key: string, model: LanguageModelV3): void {
    this._activeModels.set(key, model);
    this.notify();
  }

  /** Remove an active model instance. Notifies listeners. */
  removeActiveModel(key: string): void {
    this._activeModels.delete(key);
    this.notify();
  }

  /**
   * Get a LanguageModelV3 for an already-activated model.
   * Throws if the model is not active.
   */
  getLanguageModel(key: string): LanguageModelV3 {
    const model = this._activeModels.get(key);
    if (!model) {
      const state = this._states.get(key);
      throw new Error(
        `Model "${key}" is not ready (status: ${state?.status ?? "unknown"})`,
      );
    }
    return model;
  }
}
