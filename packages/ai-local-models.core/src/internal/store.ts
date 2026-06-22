import { type FilesApi, tryReadText, writeText } from "@statewalker/webrun-files";

const SCHEMA_VERSION = 1 as const;
const FILENAME = "local-models.json";
/** Legacy file the local section used to live inside (owned by the
 * now-removed `ai-providers` fragment). Read once for migration. */
const LEGACY_PROVIDERS_FILENAME = "providers.json";

/** A downloaded local model. */
export interface LocalModelDownload {
  /** Catalog key (e.g. `"local:smollm2-360m"`). */
  key: string;
  /** Unix-ms timestamp of download completion. */
  downloadedAt: number;
}

export interface LocalModelsConfig {
  schemaVersion: typeof SCHEMA_VERSION;
  downloaded: LocalModelDownload[];
  /** Catalog key of the active local model, or undefined when no local
   * model is the current global selection. */
  active?: string;
}

export const emptyLocalModelsConfig: LocalModelsConfig = {
  schemaVersion: SCHEMA_VERSION,
  downloaded: [],
};

function path(systemFolder: string, file: string): string {
  const trimmed = systemFolder.replace(/^\/+|\/+$/g, "");
  return `/${trimmed}/${file}`;
}

function normalise(parsed: Partial<LocalModelsConfig>): LocalModelsConfig {
  return {
    schemaVersion: SCHEMA_VERSION,
    downloaded: (parsed.downloaded ?? []).filter(
      (d): d is LocalModelDownload => typeof d?.key === "string",
    ),
    active: typeof parsed.active === "string" ? parsed.active : undefined,
  };
}

/** Shape of the legacy `providers.json` `local` + `active` sections we
 * migrate from. Read defensively — we never import `ai-providers`. */
interface LegacyProvidersConfig {
  local?: { downloaded?: LocalModelDownload[]; lastActivatedKey?: string };
  active?: { providerId?: string; modelId?: string };
}

/** Build a fresh config from the legacy `providers.json` local section.
 * The active local model is restored only when `providers.json` had a
 * `local` active pointer (`active.providerId === "local"`); the
 * `lastActivatedKey` is a dialog preselect hint, not the global
 * selection, so it does NOT become `config.active`. */
function migrateFromProviders(parsed: LegacyProvidersConfig): LocalModelsConfig | undefined {
  const downloaded = (parsed.local?.downloaded ?? []).filter(
    (d): d is LocalModelDownload => typeof d?.key === "string",
  );
  const active =
    parsed.active?.providerId === "local" && typeof parsed.active.modelId === "string"
      ? parsed.active.modelId
      : undefined;
  if (downloaded.length === 0 && active === undefined) return undefined;
  return { schemaVersion: SCHEMA_VERSION, downloaded, active };
}

/**
 * Load the local-models config. Reads `local-models.json`; when absent,
 * performs a one-time migration from the legacy `providers.json` local
 * section and writes `local-models.json` so the migration is idempotent.
 * `providers.json` is never read again once `local-models.json` exists.
 */
export async function loadLocalModelsConfig(
  files: FilesApi,
  systemFolder: string,
): Promise<LocalModelsConfig> {
  const text = await tryReadText(files, path(systemFolder, FILENAME));
  if (text !== undefined) {
    try {
      return normalise(JSON.parse(text) as Partial<LocalModelsConfig>);
    } catch {
      return { ...emptyLocalModelsConfig };
    }
  }
  // No own store yet — migrate from providers.json once.
  const legacy = await tryReadText(files, path(systemFolder, LEGACY_PROVIDERS_FILENAME));
  if (legacy !== undefined) {
    try {
      const migrated = migrateFromProviders(JSON.parse(legacy) as LegacyProvidersConfig);
      if (migrated) {
        await saveLocalModelsConfig(files, systemFolder, migrated);
        return migrated;
      }
    } catch {
      /* fall through to empty */
    }
  }
  return { ...emptyLocalModelsConfig };
}

export async function saveLocalModelsConfig(
  files: FilesApi,
  systemFolder: string,
  config: LocalModelsConfig,
): Promise<void> {
  await writeText(
    files,
    path(systemFolder, FILENAME),
    JSON.stringify({ ...config, schemaVersion: SCHEMA_VERSION }, null, 2),
  );
}
