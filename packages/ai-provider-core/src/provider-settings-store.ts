import { type FilesApi, readText } from "@statewalker/webrun-files";

const SETTINGS_DIR = "/.settings";
const PROVIDERS_PATH = "/.settings/providers.json";
const LEGACY_KEY_PATH = "/.settings/key.json";

const DEBOUNCE_MS = 200;

export interface ProviderEntry {
  apiKey?: string;
  baseURL?: string;
}

/** One named instance of an openai-compatible endpoint. */
export interface OpenAICompatibleEntry extends ProviderEntry {
  baseURL: string;
  displayName: string;
}

export interface ActiveModelsSet {
  reasoning: string[];
  embedding: string[];
}

export interface ProviderSettings {
  /** Canonical provider settings keyed by provider name. */
  anthropic?: ProviderEntry;
  google?: ProviderEntry;
  openai?: ProviderEntry;
  /** Custom OpenAI-compatible endpoints keyed by instance id. */
  "openai-compatible"?: Record<string, OpenAICompatibleEntry>;
  /** User-activated model sets persisted across sessions. */
  activeModels?: ActiveModelsSet;
}

/** Defaults ActiveModelsSet when the section is missing from disk. */
const emptyActiveModels = (): ActiveModelsSet => ({
  reasoning: [],
  embedding: [],
});

/**
 * Loads and saves per-provider API keys plus the set of user-activated
 * reasoning/embedding models. Stored at `/.settings/providers.json`.
 *
 * Shape on disk:
 *   { anthropic:   { apiKey, baseURL? },
 *     google:      { apiKey, baseURL? },
 *     openai:      { apiKey, baseURL? },
 *     openai-compatible: { "<instanceId>": { apiKey?, baseURL, displayName } },
 *     activeModels: { reasoning: [...], embedding: [...] } }
 *
 * Auto-migrates from legacy `/.settings/key.json` on first load (single
 * provider + flat model array). Activation flags from the legacy file seed
 * `activeModels.reasoning`.
 *
 * Writes are debounced (~200 ms trailing) and can be flushed manually via
 * `flush()`. `save()` schedules a debounced write; `saveNow()` writes
 * synchronously. The store keeps the latest-requested content so only one
 * flush hits disk per burst.
 */
export class ProviderSettingsStore {
  private pending: ProviderSettings | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private readonly beforeUnloadHandler = () => {
    void this.flush();
  };

  constructor(private readonly files: FilesApi) {
    if (typeof globalThis.addEventListener === "function") {
      globalThis.addEventListener("beforeunload", this.beforeUnloadHandler);
    }
  }

  /**
   * Detach the beforeunload listener. Tests should call this to avoid
   * leaking handlers between test cases.
   */
  dispose(): void {
    if (typeof globalThis.removeEventListener === "function") {
      globalThis.removeEventListener("beforeunload", this.beforeUnloadHandler);
    }
  }

  async load(): Promise<ProviderSettings> {
    try {
      if (await this.files.exists(PROVIDERS_PATH)) {
        const text = await readText(this.files, PROVIDERS_PATH);
        return normalize(JSON.parse(text) as ProviderSettings);
      }
      return this.migrateFromLegacy();
    } catch {
      return {};
    }
  }

  /** Queue a debounced write of `settings` to `/.settings/providers.json`. */
  save(settings: ProviderSettings): void {
    this.pending = settings;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush();
    }, DEBOUNCE_MS);
  }

  /** Write immediately, bypassing the debounce. */
  async saveNow(settings: ProviderSettings): Promise<void> {
    this.pending = settings;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  /** Flush any pending write. Resolves after the write completes. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.pending) return this.inFlight ?? Promise.resolve();
    const toWrite = this.pending;
    this.pending = null;
    this.inFlight = (async () => {
      const content = JSON.stringify(toWrite, null, 2);
      await this.files.mkdir(SETTINGS_DIR);
      await this.files.write(PROVIDERS_PATH, [new TextEncoder().encode(content)]);
    })();
    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async migrateFromLegacy(): Promise<ProviderSettings> {
    try {
      if (!(await this.files.exists(LEGACY_KEY_PATH))) return {};
      const text = await readText(this.files, LEGACY_KEY_PATH);
      const data = JSON.parse(text) as LegacyKeyJson;
      if (!data.apiKey || !data.provider) return {};

      const reasoningIds = (data.models ?? [])
        .filter((m) => m.type === "reasoning" && m.model)
        .map((m) => `${data.provider}:${m.model}`);

      const settings: ProviderSettings = {
        [data.provider]: { apiKey: data.apiKey },
        activeModels: {
          reasoning: reasoningIds,
          embedding: [],
        },
      };
      // Write migrated file (don't delete key.json for backward compat).
      await this.saveNow(settings);
      return settings;
    } catch {
      return {};
    }
  }
}

interface LegacyKeyJson {
  apiKey?: string;
  provider?: string;
  models?: Array<{ type?: string; model?: string }>;
}

/**
 * Fill in defaults for missing sections so callers never have to null-check
 * `activeModels` or the openai-compatible map.
 */
function normalize(raw: ProviderSettings): ProviderSettings {
  return {
    ...raw,
    "openai-compatible": raw["openai-compatible"] ?? {},
    activeModels: {
      reasoning: raw.activeModels?.reasoning ?? [],
      embedding: raw.activeModels?.embedding ?? [],
    },
  };
}

export { emptyActiveModels };
