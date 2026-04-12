import { type FilesApi, readText } from "@statewalker/webrun-files";

const SETTINGS_DIR = "/.settings";
const PROVIDERS_PATH = "/.settings/providers.json";
const LEGACY_KEY_PATH = "/.settings/key.json";

export interface ProviderEntry {
  apiKey: string;
  baseURL?: string;
}

export type ProviderSettings = Record<string, ProviderEntry>;

/**
 * Loads and saves per-provider API keys and base URLs.
 * Stores in `/.settings/providers.json`.
 * Auto-migrates from legacy `/.settings/key.json` on first load.
 */
export class ProviderSettingsStore {
  constructor(private readonly files: FilesApi) {}

  async load(): Promise<ProviderSettings> {
    try {
      if (await this.files.exists(PROVIDERS_PATH)) {
        const text = await readText(this.files, PROVIDERS_PATH);
        return JSON.parse(text) as ProviderSettings;
      }
      // Auto-migrate from legacy key.json
      return this.migrateFromLegacy();
    } catch {
      return {};
    }
  }

  async save(settings: ProviderSettings): Promise<void> {
    const content = JSON.stringify(settings, null, 2);
    await this.files.mkdir(SETTINGS_DIR);
    await this.files.write(PROVIDERS_PATH, [new TextEncoder().encode(content)]);
  }

  private async migrateFromLegacy(): Promise<ProviderSettings> {
    try {
      if (!(await this.files.exists(LEGACY_KEY_PATH))) return {};
      const text = await readText(this.files, LEGACY_KEY_PATH);
      const data = JSON.parse(text);
      if (!data.apiKey || !data.provider) return {};

      const settings: ProviderSettings = {
        [data.provider]: { apiKey: data.apiKey },
      };
      // Write the migrated file (don't delete key.json for backward compat)
      await this.save(settings);
      return settings;
    } catch {
      return {};
    }
  }
}
