import {
  type FilesApi,
  tryReadText,
  writeText,
} from "@statewalker/webrun-files";

const SCHEMA_VERSION = 3;
const PROVIDERS_FILENAME = "providers.json";

/**
 * Canonical provider names. These are first-party Vercel-AI-SDK providers
 * with stable model catalogs. Each is configured with just an API key.
 */
export type CanonicalProviderName = "openai" | "anthropic" | "google";
export const CANONICAL_PROVIDERS: readonly CanonicalProviderName[] = [
  "openai",
  "anthropic",
  "google",
];

export interface CanonicalCredentials {
  apiKey: string;
}

/** A user-defined OpenAI-compatible endpoint. */
export interface CustomProvider {
  id: string; // local unique id
  name: string; // display name
  baseURL: string;
  apiKey: string;
}

export interface ProvidersConfig {
  schemaVersion: typeof SCHEMA_VERSION;
  remote: Partial<Record<CanonicalProviderName, CanonicalCredentials>>;
  custom: CustomProvider[];
  active: {
    /**
     * Provider id: a `CanonicalProviderName`, a custom-provider `id`, or
     * the literal string `"local"` for a WebLLM model.
     */
    providerId?: string;
    /**
     * Model id for the active provider. For `providerId === "local"` this
     * is the WebLLM catalog key (e.g., `webllm:llama-3.2-3b`).
     */
    modelId?: string;
  };
  /** Local model state (informational; does not auto-activate). */
  local: {
    /** Last activated catalog key — pre-selects the row in the UI. */
    lastActivatedKey?: string;
  };
}

export const emptyProvidersConfig: ProvidersConfig = {
  schemaVersion: SCHEMA_VERSION,
  remote: {},
  custom: [],
  active: {},
  local: {},
};

function configPath(systemFolder: string): string {
  const trimmed = systemFolder.replace(/^\/+|\/+$/g, "");
  return `/${trimmed}/${PROVIDERS_FILENAME}`;
}

interface V1Config {
  schemaVersion?: number;
  remote?: Record<
    string,
    { apiKey?: string; baseURL?: string | null } | undefined
  >;
  active?: { reasoning?: string };
}

interface V2Config {
  schemaVersion: 2;
  remote?: ProvidersConfig["remote"];
  custom?: CustomProvider[];
  active?: ProvidersConfig["active"];
}

function migrateFromV1(parsed: V1Config): ProvidersConfig {
  const remote: ProvidersConfig["remote"] = {};
  const custom: CustomProvider[] = [];
  for (const [name, cred] of Object.entries(parsed.remote ?? {})) {
    if (!cred?.apiKey) continue;
    if (name === "openai" || name === "anthropic" || name === "google") {
      remote[name] = { apiKey: cred.apiKey };
    } else if (name === "openai-compatible" && cred.baseURL) {
      // Promote the single legacy OpenAI-compatible entry to a named custom
      // provider so the user can rename it later.
      custom.push({
        id: `custom-${Date.now()}`,
        name: "OpenAI-compatible",
        baseURL: cred.baseURL,
        apiKey: cred.apiKey,
      });
    }
  }
  // V1 had `active.reasoning = "<modelId>"` without a provider id. We
  // can't reliably infer the provider, so drop the active selection on
  // migration — the user re-picks once.
  return {
    schemaVersion: SCHEMA_VERSION,
    remote,
    custom,
    active: {},
    local: {},
  };
}

function migrateFromV2(parsed: V2Config): ProvidersConfig {
  return {
    schemaVersion: SCHEMA_VERSION,
    remote: parsed.remote ?? {},
    custom: parsed.custom ?? [],
    active: parsed.active ?? {},
    local: {},
  };
}

export async function loadProvidersConfig(
  files: FilesApi,
  systemFolder: string,
): Promise<ProvidersConfig> {
  const text = await tryReadText(files, configPath(systemFolder));
  if (text === undefined) {
    return {
      ...emptyProvidersConfig,
      remote: {},
      custom: [],
      active: {},
      local: {},
    };
  }
  try {
    const parsed = JSON.parse(text) as {
      schemaVersion?: number;
      [key: string]: unknown;
    };
    const version: number = parsed.schemaVersion ?? 1;
    if (version === 1) {
      return migrateFromV1(parsed as V1Config);
    }
    if (version === 2) {
      return migrateFromV2(parsed as V2Config);
    }
    const v3 = parsed as Partial<ProvidersConfig>;
    return {
      schemaVersion: SCHEMA_VERSION,
      remote: v3.remote ?? {},
      custom: v3.custom ?? [],
      active: v3.active ?? {},
      local: v3.local ?? {},
    };
  } catch {
    return {
      ...emptyProvidersConfig,
      remote: {},
      custom: [],
      active: {},
      local: {},
    };
  }
}

export async function saveProvidersConfig(
  files: FilesApi,
  systemFolder: string,
  config: ProvidersConfig,
): Promise<void> {
  const path = configPath(systemFolder);
  const json = JSON.stringify(
    {
      schemaVersion: SCHEMA_VERSION,
      remote: config.remote,
      custom: config.custom,
      active: config.active,
      local: config.local,
    },
    null,
    2,
  );
  await writeText(files, path, json);
}

/** All configured providers (canonical with apiKey + all custom entries). */
export interface ConfiguredProvider {
  id: string; // canonical name OR custom id
  kind: "canonical" | "custom";
  /** Display name. */
  label: string;
  /** Canonical name for `createRemoteProvider` (always one of the four). */
  providerName: CanonicalProviderName | "openai-compatible";
  apiKey: string;
  baseURL: string | undefined;
}

export function listConfiguredProviders(
  config: ProvidersConfig,
): ConfiguredProvider[] {
  const out: ConfiguredProvider[] = [];
  for (const name of CANONICAL_PROVIDERS) {
    const cred = config.remote[name];
    if (cred?.apiKey) {
      out.push({
        id: name,
        kind: "canonical",
        label: canonicalLabel(name),
        providerName: name,
        apiKey: cred.apiKey,
        baseURL: undefined,
      });
    }
  }
  for (const c of config.custom) {
    if (c.apiKey && c.baseURL) {
      out.push({
        id: c.id,
        kind: "custom",
        label: c.name || "Untitled",
        providerName: "openai-compatible",
        apiKey: c.apiKey,
        baseURL: c.baseURL,
      });
    }
  }
  return out;
}

export function findConfiguredProvider(
  config: ProvidersConfig,
  providerId: string | undefined,
): ConfiguredProvider | undefined {
  if (!providerId) return undefined;
  return listConfiguredProviders(config).find((p) => p.id === providerId);
}

export function canonicalLabel(name: CanonicalProviderName): string {
  switch (name) {
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    case "google":
      return "Google";
  }
}

export function newCustomProviderId(): string {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
