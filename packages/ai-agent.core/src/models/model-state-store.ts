import type { EmbeddingModelV3, ImageModelV3, LanguageModelV3, ProviderV3 } from "@ai-sdk/provider";
import { NoSuchModelError } from "@ai-sdk/provider";
import type {
  ActivationProgress,
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
 *
 * Also implements `ProviderV3` so it can be passed directly to
 * `AgentRuntime.addModelProvider()`. Only `languageModel` is supported;
 * `embeddingModel` and `imageModel` throw `NoSuchModelError`.
 */
export class ModelStateStore implements ProviderV3 {
  readonly specificationVersion = "v3" as const;
  private readonly _catalog: Record<string, ModelConfig>;
  private readonly _states = new Map<string, ModelState>();
  private readonly _activeModels = new Map<string, LanguageModelV3>();
  private readonly _downloadProgress = new Map<string, ActivationProgress>();
  /**
   * Provider settings keyed by `{provider}` for canonical providers, or
   * `{provider}:{instanceId}` for `openai-compatible` instances.
   */
  private readonly _providerSettings = new Map<string, RemoteProviderSettings>();
  private readonly _listeners = new Set<() => void>();

  constructor(catalog: Record<string, ModelConfig>) {
    this._catalog = catalog;
    for (const [key, config] of Object.entries(catalog)) {
      this._states.set(key, {
        config,
        status: config.runtime === "local" ? "not-downloaded" : "not-downloaded",
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

  /**
   * Add a new catalog entry at runtime (e.g. after discovering a remote
   * model). Seeds its state with `not-downloaded` and notifies listeners.
   * Idempotent: existing entries are overwritten (their state reset).
   */
  addCatalogEntry(key: string, config: ModelConfig): void {
    this._catalog[key] = config;
    this._states.set(key, { config, status: "not-downloaded" });
    this.notify();
  }

  // ── Provider settings ─────────────────────────────────────────────────

  /**
   * Compose a storage key: `{provider}` for canonical providers,
   * `{provider}:{instanceId}` for openai-compatible instances.
   */
  private providerKey(provider: ProviderName, instanceId?: string): string {
    return instanceId ? `${provider}:${instanceId}` : provider;
  }

  /** Get settings for a specific provider (optionally scoped to an instance). */
  getProviderSettings(
    provider: ProviderName,
    instanceId?: string,
  ): RemoteProviderSettings | undefined {
    return this._providerSettings.get(this.providerKey(provider, instanceId));
  }

  /** Get all provider settings keyed by composite key. */
  get providerSettings(): ReadonlyMap<string, RemoteProviderSettings> {
    return this._providerSettings;
  }

  /** Whether any provider has an API key configured. */
  get hasConfiguredProvider(): boolean {
    for (const s of this._providerSettings.values()) {
      if (s.apiKey) return true;
    }
    return false;
  }

  /** Set settings for a provider (optionally scoped to an instance). Notifies listeners. */
  setProviderSettings(
    provider: ProviderName,
    settings: RemoteProviderSettings,
    instanceId?: string,
  ): void {
    this._providerSettings.set(this.providerKey(provider, instanceId), settings);
    this.notify();
  }

  /** Remove settings for a provider (optionally scoped to an instance). Notifies listeners. */
  removeProviderSettings(provider: ProviderName, instanceId?: string): void {
    if (this._providerSettings.delete(this.providerKey(provider, instanceId))) {
      this.notify();
    }
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
   *
   * Implements `ProviderV3.languageModel`.
   */
  languageModel(key: string): LanguageModelV3 {
    const model = this._activeModels.get(key);
    if (!model) {
      const state = this._states.get(key);
      throw new Error(`Model "${key}" is not ready (status: ${state?.status ?? "unknown"})`);
    }
    return model;
  }

  /** ProviderV3 conformance — embedding models are not supported. */
  embeddingModel(modelId: string): EmbeddingModelV3 {
    throw new NoSuchModelError({ modelId, modelType: "embeddingModel" });
  }

  /** ProviderV3 conformance — image models are not supported. */
  imageModel(modelId: string): ImageModelV3 {
    throw new NoSuchModelError({ modelId, modelType: "imageModel" });
  }

  /** Return the active model instance or `undefined` without throwing. */
  peekActiveModel(key: string): LanguageModelV3 | undefined {
    return this._activeModels.get(key);
  }

  // ── Download progress ───────────────────────────────────────────────

  /** Update download progress for a model. Notifies listeners. */
  setDownloadProgress(key: string, progress: ActivationProgress): void {
    this._downloadProgress.set(key, progress);
    this.notify();
  }

  /** Get the latest download progress for a model, or undefined if not downloading. */
  getDownloadProgress(key: string): ActivationProgress | undefined {
    return this._downloadProgress.get(key);
  }

  /** Clear download progress for a model. Notifies listeners. */
  clearDownloadProgress(key: string): void {
    if (this._downloadProgress.delete(key)) {
      this.notify();
    }
  }

  /** Get all active downloads (models with status "downloading"). */
  getActiveDownloads(): Map<string, ActivationProgress> {
    return new Map(this._downloadProgress);
  }
}
