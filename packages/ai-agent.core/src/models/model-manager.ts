import type { LanguageModelV3, ProviderV3 } from "@ai-sdk/provider";
import type { FilesApi } from "@statewalker/webrun-files";
import { createRemoteProvider } from "./create-remote-provider.js";
import {
  type FileResolver,
  LocalModelStorage,
  type WeightVerifier,
} from "./local-model-storage.js";
import type { ModelStateStore } from "./model-state-store.js";
import { type DiscoveredModel, listModels } from "./remote-discovery.js";
import type {
  ActivationProgress,
  EngineId,
  LocalModelConfig,
  LocalModelFactory,
  ProviderName,
  RemoteModelConfig,
  RemoteProviderSettings,
} from "./types.js";
import { verifyModelAccess } from "./verify-model.js";

/**
 * Registration for a local engine: the factory that creates
 * `LanguageModelV3` instances and optional helpers for custom download
 * and weight-verification logic.
 */
export interface LocalEngineRegistration {
  factory: LocalModelFactory;
  /** Custom file resolver (e.g. MLC shard listing, single GGUF file). */
  fileResolver?: FileResolver;
  /** Custom weight-presence verifier (defaults to ONNX file check). */
  verifier?: WeightVerifier;
  /**
   * Engine-owned weight-presence check. When provided, takes precedence
   * over the FilesApi-backed `LocalModelStorage.hasWeights(verifier)`
   * path. Use this when the default check (which requires a metadata
   * file written by `LocalModelStorage.download`) is wrong for your
   * engine — for example WebLLM streams weights directly into a
   * Service-Worker-bridged FilesApi without going through
   * `LocalModelStorage.download`, so the metadata file never exists.
   *
   * The `files` argument is the FilesApi configured on the
   * `ModelManager` (or `undefined` if no files were configured).
   */
  engineHasWeights?: (config: LocalModelConfig, files: FilesApi | undefined) => Promise<boolean>;
}

/**
 * Operations controller for model activation lifecycle.
 * Performs external API calls (provider creation, verification, downloads)
 * and updates the ModelStateStore at each step.
 * UI controllers should subscribe to ModelStateStore, not to ModelManager.
 */
export class ModelManager {
  readonly store: ModelStateStore;
  /** FilesApi used for model storage, or undefined if not configured. */
  readonly files: FilesApi | undefined;
  /** Root path under which engine-specific subdirectories are created. */
  private readonly basePath: string;
  private readonly engines = new Map<EngineId, LocalEngineRegistration>();
  private readonly storageByEngine = new Map<EngineId, LocalModelStorage>();
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(options: {
    store: ModelStateStore;
    files?: FilesApi;
    modelStoragePath?: string;
  }) {
    this.store = options.store;
    this.files = options.files;
    this.basePath = options.modelStoragePath ?? "/models";
  }

  /**
   * The `ProviderV3` face of this manager — its underlying
   * {@link ModelStateStore}. Pass to `AgentRuntime.addModelProvider()`.
   */
  get provider(): ProviderV3 {
    return this.store;
  }

  /**
   * Register an engine-specific factory (and optional resolver/verifier).
   * Overloads accept either a single factory or a `LocalEngineRegistration`
   * with resolver/verifier hooks.
   */
  registerLocalFactory(
    engine: EngineId,
    factoryOrRegistration: LocalModelFactory | LocalEngineRegistration,
  ): void {
    const registration: LocalEngineRegistration =
      typeof factoryOrRegistration === "function"
        ? { factory: factoryOrRegistration }
        : factoryOrRegistration;
    this.engines.set(engine, registration);
  }

  /** Returns true if a factory has been registered for the given engine. */
  hasFactory(engine: EngineId): boolean {
    return this.engines.has(engine);
  }

  /**
   * Reconcile each local catalog entry's persisted state with what is
   * actually on disk: if `hasWeights()` returns true, flip the store status
   * to `"downloaded"` so the UI reflects an existing download (e.g. weights
   * left over from a previous session).
   *
   * Skips entries whose current status is `"ready"` (the model is loaded in
   * memory — overwriting would lose that), `"downloading"` (a transfer is
   * in flight), or `"downloaded"` (already correct). Engines without a
   * registered factory are skipped because we cannot consult their
   * verifier — the matching engine package registers itself separately.
   *
   * Call after registering all engine factories. Without this scan, the
   * store seeds every local entry as `"not-downloaded"` and stale weights
   * on disk are invisible to the UI until the user explicitly downloads.
   */
  async refreshLocalStatuses(): Promise<void> {
    const checks: Promise<void>[] = [];
    for (const [key, config] of Object.entries(this.store.catalog)) {
      if (config.runtime !== "local") continue;
      const status = this.store.getState(key)?.status;
      if (status === "ready" || status === "downloading" || status === "downloaded") continue;
      const registration = this.engines.get(config.engine);
      if (!registration) continue;
      const presence: Promise<boolean> = registration.engineHasWeights
        ? registration.engineHasWeights(config, this.files)
        : (async () => {
            const storage = this.storageFor(config.engine);
            if (!storage) return false;
            return storage.hasWeights(config.modelId, registration.verifier);
          })();
      checks.push(
        presence
          .then((present) => {
            if (present) this.store.setStatus(key, "downloaded");
          })
          .catch(() => {
            // Best-effort scan; ignore per-entry errors.
          }),
      );
    }
    await Promise.all(checks);
  }

  /** Get (or lazily build) the storage backend for an engine. */
  private storageFor(engine: EngineId): LocalModelStorage | undefined {
    if (!this.files) return undefined;
    let storage = this.storageByEngine.get(engine);
    if (!storage) {
      storage = new LocalModelStorage(this.files, {
        basePath: this.basePath,
        engine,
      });
      this.storageByEngine.set(engine, storage);
    }
    return storage;
  }

  /**
   * Activate a model, yielding progress events.
   * For remote: creates provider from settings, verifies access.
   * For local: downloads if needed, loads, warms up.
   * Updates ModelStateStore at each step.
   */
  async *activate(
    key: string,
    options?: {
      /** Provider settings for remote models (apiKey, baseURL, headers, etc.) */
      settings?: RemoteProviderSettings;
      signal?: AbortSignal;
    },
  ): AsyncGenerator<ActivationProgress> {
    const config = this.store.catalog[key];
    if (!config) {
      yield {
        modelKey: key,
        phase: "error",
        message: `Unknown model: ${key}`,
        error: new Error(`Unknown model: ${key}`),
      };
      return;
    }

    // Guard: cannot activate while a download is in progress
    const currentStatus = this.store.getState(key)?.status;
    if (currentStatus === "downloading") {
      yield {
        modelKey: key,
        phase: "error",
        message: `Model "${key}" is currently being downloaded. Wait for the download to complete before activating.`,
        error: new Error(
          `Model "${key}" is currently being downloaded. Wait for the download to complete before activating.`,
        ),
      };
      return;
    }

    const cleanup: (() => void)[] = [];
    const ac = new AbortController();
    this.abortControllers.set(key, ac);
    cleanup.push(() => this.abortControllers.delete(key));

    const signal = options?.signal;
    if (signal) {
      const interrupt = () => ac.abort(signal.reason);
      signal.addEventListener("abort", interrupt);
      cleanup.push(() => signal.removeEventListener("abort", interrupt));
    }

    try {
      this.store.setStatus(key, "loading");

      if (config.runtime === "remote") {
        yield* this.activateRemote(key, config, options?.settings, ac.signal);
      } else {
        yield* this.activateLocal(key, config, ac.signal);
      }
    } finally {
      for (const fn of cleanup) {
        fn();
      }
    }
  }

  /**
   * Unload a model from memory. If the language-model instance implements
   * `[Symbol.dispose]` / `[Symbol.asyncDispose]`, the disposer is invoked
   * so engines like llama.cpp can free their native LlamaContext/LlamaModel.
   */
  deactivate(key: string): void {
    const model = this.store.peekActiveModel(key);
    this.store.removeActiveModel(key);
    const state = this.store.getState(key);
    if (state && state.config.runtime === "local") {
      this.store.setStatus(key, "downloaded");
    }
    disposeModel(model);
  }

  /** Cancel an in-progress activation. */
  cancel(key: string): void {
    const ac = this.abortControllers.get(key);
    if (ac) {
      ac.abort(new Error("Cancelled"));
      this.abortControllers.delete(key);
    }
  }

  /** Delete downloaded weights for a local model. */
  async deleteLocal(key: string): Promise<void> {
    this.deactivate(key);
    const config = this.store.catalog[key];
    if (config?.runtime === "local") {
      const storage = this.storageFor(config.engine);
      if (storage) await storage.delete(config.modelId);
    }
    this.store.setStatus(key, "not-downloaded");
  }

  /**
   * Download model weights without loading into memory.
   * For remote models: no-op (yields a single "ready" event).
   * For local models: delegates to LocalModelStorage.download() with progress tracking.
   * Supports resume from partial downloads via HTTP Range headers.
   */
  async *download(key: string, signal?: AbortSignal): AsyncGenerator<ActivationProgress> {
    const config = this.store.catalog[key];
    if (!config) {
      yield {
        modelKey: key,
        phase: "error",
        message: `Unknown model: ${key}`,
        error: new Error(`Unknown model: ${key}`),
      };
      return;
    }

    // Remote models don't need downloading
    if (config.runtime === "remote") {
      yield {
        modelKey: key,
        phase: "ready",
        message: "Remote model — no download needed",
      };
      return;
    }

    // Already downloaded or ready — skip
    const currentStatus = this.store.getState(key)?.status;
    if (currentStatus === "downloaded" || currentStatus === "ready") {
      yield { modelKey: key, phase: "ready", message: "Already downloaded" };
      return;
    }

    const storage = this.storageFor(config.engine);
    if (!storage) {
      const error = new Error(
        "No FilesApi configured for local model storage. Provide `files` option to ModelManager.",
      );
      this.store.setStatus(key, "error", error);
      yield { modelKey: key, phase: "error", message: error.message, error };
      return;
    }

    const registration = this.engines.get(config.engine);
    const ac = new AbortController();
    this.abortControllers.set(key, ac);
    const cleanup: (() => void)[] = [() => this.abortControllers.delete(key)];

    if (signal) {
      const interrupt = () => ac.abort(signal.reason);
      signal.addEventListener("abort", interrupt);
      cleanup.push(() => signal.removeEventListener("abort", interrupt));
    }

    try {
      this.store.setStatus(key, "downloading");

      for await (const progress of storage.download(key, config.modelId, config, {
        fileResolver: registration?.fileResolver,
        signal: ac.signal,
      })) {
        this.store.setDownloadProgress(key, progress);
        yield progress;
      }

      this.store.setStatus(key, "downloaded");
      this.store.clearDownloadProgress(key);
      yield {
        modelKey: key,
        phase: "ready",
        message: `${config.label} downloaded`,
      };
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      if (ac.signal.aborted) {
        // Cancelled — mark as partial so it can be resumed
        this.store.setStatus(key, "partial");
      } else {
        this.store.setStatus(key, "error", error);
      }
      this.store.clearDownloadProgress(key);
      if (!ac.signal.aborted) {
        yield { modelKey: key, phase: "error", message: error.message, error };
      }
    } finally {
      for (const fn of cleanup) fn();
    }
  }

  /**
   * Test credentials for a remote provider by listing its models.
   * Never mutates persistent state or the store — callers decide what to
   * persist based on the returned list.
   */
  async testConnection(
    providerType: ProviderName,
    settings: RemoteProviderSettings,
  ): Promise<DiscoveredModel[]> {
    return listModels(providerType, settings);
  }

  /**
   * Import a set of discovered models into the runtime catalog as
   * `RemoteModelConfig` entries. Idempotent: existing entries for the same
   * (provider, providerInstanceId, modelId) keep their status but have their
   * label refreshed. Persists provider settings via the store in the same
   * pass so callers only notify once.
   */
  importDiscoveredModels(
    providerType: ProviderName,
    providerInstanceId: string | null,
    selected: DiscoveredModel[],
    settings: RemoteProviderSettings,
  ): string[] {
    const prefix = providerInstanceId ? `${providerType}:${providerInstanceId}` : providerType;
    const catalog = this.store.catalog as Record<string, RemoteModelConfig>;
    const addedKeys: string[] = [];
    for (const entry of selected) {
      const key = `${prefix}/${entry.id}`;
      const existing = catalog[key];
      if (existing) {
        existing.label = entry.label;
        continue;
      }
      const config: RemoteModelConfig = {
        runtime: "remote",
        provider: providerType,
        modelId: entry.id,
        label: entry.label,
        kinds: ["reasoning"],
        ...(providerInstanceId ? { providerInstanceId } : {}),
      };
      this.store.addCatalogEntry(key, config);
      addedKeys.push(key);
    }
    this.store.setProviderSettings(providerType, settings, providerInstanceId ?? undefined);
    return addedKeys;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async *activateRemote(
    key: string,
    config: { runtime: "remote"; provider: ProviderName; modelId: string },
    settings: RemoteProviderSettings | undefined,
    signal: AbortSignal,
  ): AsyncGenerator<ActivationProgress> {
    if (!settings?.apiKey && !settings?.authToken) {
      const error = new Error(
        `No API key or auth token for provider "${config.provider}". ` +
          "Provide settings.apiKey or settings.authToken in activate() options.",
      );
      this.store.setStatus(key, "error", error);
      yield { modelKey: key, phase: "error", message: error.message, error };
      return;
    }

    yield {
      modelKey: key,
      phase: "verifying",
      message: `Verifying access for ${config.provider}/${config.modelId}...`,
    };

    try {
      const provider = createRemoteProvider(config.provider, settings);
      await verifyModelAccess(provider, config.modelId, signal);

      const model = provider.languageModel(config.modelId);
      this.store.setActiveModel(key, model);
      this.store.setStatus(key, "ready");

      yield { modelKey: key, phase: "ready", message: "Model ready" };
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      this.store.setStatus(key, "error", error);
      yield { modelKey: key, phase: "error", message: error.message, error };
    }
  }

  private async *activateLocal(
    key: string,
    config: LocalModelConfig,
    signal: AbortSignal,
  ): AsyncGenerator<ActivationProgress> {
    const registration = this.engines.get(config.engine);
    if (!registration) {
      const error = new Error(
        `No factory registered for engine '${config.engine}'. ` +
          `Install the matching provider package and call its register${
            config.engine === "tjs"
              ? "LocalProvider"
              : config.engine === "webllm"
                ? "WebLLMProvider"
                : "LlamaCppProvider"
          }(manager) before activating.`,
      );
      this.store.setStatus(key, "error", error);
      yield { modelKey: key, phase: "error", message: error.message, error };
      return;
    }

    const storage = this.storageFor(config.engine);
    if (!storage) {
      const error = new Error(
        "No FilesApi configured for local model storage. Provide `files` option to ModelManager.",
      );
      this.store.setStatus(key, "error", error);
      yield { modelKey: key, phase: "error", message: error.message, error };
      return;
    }

    yield {
      modelKey: key,
      phase: "checking",
      message: `Checking storage for ${config.label}...`,
    };

    // Engine-owned check (e.g. WebLLM via SW-bridged FilesApi) takes
    // precedence over the FilesApi-backed default — engines that don't
    // write through `LocalModelStorage.download` need to short-circuit
    // the download path themselves.
    const hasWeights = registration.engineHasWeights
      ? await registration.engineHasWeights(config, this.files)
      : await storage.hasWeights(config.modelId, registration.verifier);

    if (!hasWeights && !registration.engineHasWeights) {
      // Only run the FilesApi-backed download for engines that use FilesApi.
      // Engines with a custom `engineHasWeights` are expected to handle
      // their own weight fetching inside the factory.
      for await (const progress of storage.download(key, config.modelId, config, {
        fileResolver: registration.fileResolver,
        signal,
      })) {
        yield progress;
      }
    }

    try {
      // Bridge the factory's push-style `onProgress` callback into our
      // pull-style async generator. Each callback enqueues a progress event
      // and wakes the loop, which yields any queued events alongside the
      // factory promise. Without this, factory-phase progress (e.g.
      // WebLLM's `engine.reload` shard loading) is invisible to callers and
      // the UI appears stuck on the last download/checking event.
      const queue: ActivationProgress[] = [];
      let wake: (() => void) | null = null;
      const onProgress = (progress: ActivationProgress): void => {
        queue.push(progress);
        const w = wake;
        wake = null;
        w?.();
      };

      let model: LanguageModelV3 | undefined;
      let factoryError: unknown;
      let done = false;
      const factoryPromise = registration
        .factory(config.modelId, config, storage.files, onProgress, signal)
        .then(
          (m) => {
            model = m;
            done = true;
            const w = wake;
            wake = null;
            w?.();
          },
          (e) => {
            factoryError = e;
            done = true;
            const w = wake;
            wake = null;
            w?.();
          },
        );

      while (true) {
        while (queue.length > 0) {
          const next = queue.shift();
          if (next) yield next;
        }
        if (done) break;
        // Race the factory's completion against the next onProgress
        // callback. The double-check inside the wake promise constructor
        // handles the rare case where the factory finished between the
        // outer `done` check and the wake assignment — without it, the
        // wake would never fire and the loop would deadlock.
        await Promise.race([
          factoryPromise,
          new Promise<void>((resolve) => {
            if (done || queue.length > 0) {
              resolve();
              return;
            }
            wake = resolve;
          }),
        ]);
      }
      await factoryPromise;
      if (factoryError) throw factoryError;
      if (!model) throw new Error("factory resolved without a model");

      this.store.setActiveModel(key, model);
      this.store.setStatus(key, "ready");
      yield { modelKey: key, phase: "ready", message: `${config.label} ready` };
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      this.store.setStatus(key, "error", error);
      yield { modelKey: key, phase: "error", message: error.message, error };
    }
  }
}

function disposeModel(model: unknown): void {
  if (!model || typeof model !== "object") return;
  const asyncDispose = (model as { [Symbol.asyncDispose]?: () => unknown })[Symbol.asyncDispose];
  if (typeof asyncDispose === "function") {
    void Promise.resolve(asyncDispose.call(model)).catch(() => {});
    return;
  }
  const sync = (model as { [Symbol.dispose]?: () => unknown })[Symbol.dispose];
  if (typeof sync === "function") {
    try {
      sync.call(model);
    } catch {
      // Swallow: disposal is best-effort.
    }
  }
}
