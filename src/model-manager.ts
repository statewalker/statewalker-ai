import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { ProviderV3 } from "@ai-sdk/provider";
import type { FilesApi } from "@statewalker/webrun-files";
import { LocalModelStorage } from "./local-model-storage.js";
import type { ModelStateStore } from "./model-state-store.js";
import type {
  ActivationProgress,
  LocalModelConfig,
  LocalModelFactory,
  ProviderName,
  RemoteProviderSettings,
} from "./types.js";
import { verifyModelAccess } from "./verify-model.js";

/**
 * Operations controller for model activation lifecycle.
 * Performs external API calls (provider creation, verification, downloads)
 * and updates the ModelStateStore at each step.
 * UI controllers should subscribe to ModelStateStore, not to ModelManager.
 */
export class ModelManager {
  readonly store: ModelStateStore;
  private readonly storage: LocalModelStorage | undefined;
  private localFactory: LocalModelFactory | undefined;
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(options: {
    store: ModelStateStore;
    files?: FilesApi;
    modelStoragePath?: string;
  }) {
    this.store = options.store;

    if (options.files) {
      this.storage = new LocalModelStorage(
        options.files,
        options.modelStoragePath ?? "/models",
      );
    }
  }

  /** Register a factory for creating local LanguageModelV3 instances. */
  registerLocalFactory(factory: LocalModelFactory): void {
    this.localFactory = factory;
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

  /** Unload a model from memory. */
  deactivate(key: string): void {
    this.store.removeActiveModel(key);
    const state = this.store.getState(key);
    if (state && state.config.runtime === "local") {
      this.store.setStatus(key, "downloaded");
    }
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
    if (config?.runtime === "local" && this.storage) {
      await this.storage.delete(config.modelId);
    }
    this.store.setStatus(key, "not-downloaded");
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private createRemoteProvider(
    providerName: ProviderName,
    settings: RemoteProviderSettings,
  ): ProviderV3 {
    switch (providerName) {
      case "anthropic":
        return createAnthropic(settings);
      case "google":
        return createGoogleGenerativeAI(settings);
      case "openai":
        return createOpenAI(settings);
      default:
        throw new Error(`Unknown provider: ${providerName as string}`);
    }
  }

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
      const provider = this.createRemoteProvider(config.provider, settings);
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
    if (!this.localFactory) {
      const error = new Error(
        "No local model provider registered. Install @statewalker/ai-provider-local and call registerLocalProvider(manager).",
      );
      this.store.setStatus(key, "error", error);
      yield { modelKey: key, phase: "error", message: error.message, error };
      return;
    }

    if (!this.storage) {
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

    const hasWeights = await this.storage.hasWeights(config.modelId);

    if (!hasWeights) {
      for await (const progress of this.storage.download(
        key,
        config.modelId,
        config,
        signal,
      )) {
        yield progress;
      }
    }

    try {
      const model = await this.localFactory(
        config.modelId,
        config,
        this.storage.files,
        () => {},
        signal,
      );

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
