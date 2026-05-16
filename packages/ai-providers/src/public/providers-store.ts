import { type FilesApi, tryReadText, writeText } from "@statewalker/webrun-files";

const SCHEMA_VERSION = 4;
const PROVIDERS_FILENAME = "providers.json";

/** Connection type. Matches the canonical Vercel-AI-SDK providers
 * plus the generic OpenAI-compatible escape hatch for proxies and
 * self-hosted endpoints. */
export type ConnectionType = "openai" | "anthropic" | "google" | "openai-compatible";

/** A model's functional role tag. Resolved by a curated table; not
 * derived from server responses. Models with no match default to
 * `["text"]`. */
export type Capability = "text" | "embedding" | "image";

/** Discovered model entry cached on a Connection by the refresh flow. */
export interface DiscoveredModel {
  id: string;
  label: string;
  capabilities?: Capability[];
}

/** A header forwarded on every outgoing call for a Connection. */
export interface ConnectionHeader {
  name: string;
  value: string;
}

/** A remote model-provider endpoint. Multiple Connections of the
 * same canonical `type` are allowed (e.g. work + personal OpenAI). */
export interface Connection {
  /** Stable id. For migrated canonical entries this is the type
   * name (`"openai"`, `"anthropic"`, `"google"`) to preserve
   * `active.providerId`. New entries get a generated id. */
  id: string;
  type: ConnectionType;
  /** Display label. */
  name: string;
  /** Optional URL override. Required for `openai-compatible`;
   * optional for canonical types (used when routing through a
   * proxy). */
  url?: string;
  apiKey: string;
  headers?: ConnectionHeader[];
  /** Cached `/v1/models` response. Populated by the refresh flow
   * in `models-config`. */
  discoveredModels?: DiscoveredModel[];
  /** Unix-ms timestamp of the last successful refresh. */
  discoveredAt?: number;
}

/** A starred model — a quick-access pair shown in the chat composer. */
export interface StarredRef {
  connectionId: string;
  modelId: string;
}

/** A downloaded local model. */
export interface LocalModelRef {
  /** Catalog key (e.g. `"local:smollm2-360m"`). */
  key: string;
  /** Unix-ms timestamp of download completion. */
  downloadedAt: number;
}

export interface ProvidersConfig {
  schemaVersion: typeof SCHEMA_VERSION;
  connections: Connection[];
  starred: StarredRef[];
  local: {
    downloaded: LocalModelRef[];
    /** Last activated local-model catalog key — pre-selects the
     * row in the Local Models dialog. */
    lastActivatedKey?: string;
  };
  active: {
    /** Connection id, or the literal `"local"` for a local model. */
    providerId?: string;
    /** Model id within the chosen provider; for `"local"` this is
     * the catalog key (e.g. `"local:smollm2-360m"`). */
    modelId?: string;
  };
}

export const emptyProvidersConfig: ProvidersConfig = {
  schemaVersion: SCHEMA_VERSION,
  connections: [],
  starred: [],
  local: { downloaded: [] },
  active: {},
};

function configPath(systemFolder: string): string {
  const trimmed = systemFolder.replace(/^\/+|\/+$/g, "");
  return `/${trimmed}/${PROVIDERS_FILENAME}`;
}

// ── Legacy shapes (read-only, for migration) ─────────────────────

interface V1Config {
  schemaVersion?: number;
  remote?: Record<string, { apiKey?: string; baseURL?: string | null } | undefined>;
  active?: { reasoning?: string };
}

interface V2OrV3Custom {
  id: string;
  name: string;
  baseURL: string;
  apiKey: string;
}

interface V2Config {
  schemaVersion: 2;
  remote?: Partial<Record<"openai" | "anthropic" | "google", { apiKey: string }>>;
  custom?: V2OrV3Custom[];
  active?: { providerId?: string; modelId?: string };
}

interface V3Config {
  schemaVersion: 3;
  remote?: Partial<Record<"openai" | "anthropic" | "google", { apiKey: string }>>;
  custom?: V2OrV3Custom[];
  active?: { providerId?: string; modelId?: string };
  local?: { lastActivatedKey?: string };
}

function canonicalLabel(type: "openai" | "anthropic" | "google"): string {
  switch (type) {
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    case "google":
      return "Google";
  }
}

function emitCanonicalConnections(remote: V3Config["remote"] | undefined): Connection[] {
  if (!remote) return [];
  const out: Connection[] = [];
  for (const type of ["openai", "anthropic", "google"] as const) {
    const entry = remote[type];
    if (!entry?.apiKey) continue;
    out.push({
      id: type,
      type,
      name: canonicalLabel(type),
      apiKey: entry.apiKey,
    });
  }
  return out;
}

function emitCustomConnections(custom: V2OrV3Custom[] | undefined): Connection[] {
  if (!custom) return [];
  const out: Connection[] = [];
  for (const c of custom) {
    if (!c.apiKey || !c.baseURL) continue;
    out.push({
      id: c.id,
      type: "openai-compatible",
      name: c.name || "Untitled",
      url: c.baseURL,
      apiKey: c.apiKey,
    });
  }
  return out;
}

function migrateFromV1(parsed: V1Config): ProvidersConfig {
  // V1 had `active.reasoning = "<modelId>"` without a provider id, so
  // we drop the active selection on migration. Canonical entries
  // become Connections; an `openai-compatible` legacy entry promotes
  // to a custom Connection.
  const remote: V3Config["remote"] = {};
  const custom: V2OrV3Custom[] = [];
  for (const [name, cred] of Object.entries(parsed.remote ?? {})) {
    if (!cred?.apiKey) continue;
    if (name === "openai" || name === "anthropic" || name === "google") {
      remote[name] = { apiKey: cred.apiKey };
    } else if (name === "openai-compatible" && cred.baseURL) {
      custom.push({
        id: `custom-${Date.now()}`,
        name: "OpenAI-compatible",
        baseURL: cred.baseURL,
        apiKey: cred.apiKey,
      });
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    connections: [...emitCanonicalConnections(remote), ...emitCustomConnections(custom)],
    starred: [],
    local: { downloaded: [] },
    active: {},
  };
}

function migrateFromV2(parsed: V2Config): ProvidersConfig {
  return {
    schemaVersion: SCHEMA_VERSION,
    connections: [
      ...emitCanonicalConnections(parsed.remote),
      ...emitCustomConnections(parsed.custom),
    ],
    starred: [],
    local: { downloaded: [] },
    active: parsed.active ?? {},
  };
}

function migrateFromV3(parsed: V3Config): ProvidersConfig {
  return {
    schemaVersion: SCHEMA_VERSION,
    connections: [
      ...emitCanonicalConnections(parsed.remote),
      ...emitCustomConnections(parsed.custom),
    ],
    starred: [],
    local: {
      downloaded: [],
      lastActivatedKey: parsed.local?.lastActivatedKey,
    },
    active: parsed.active ?? {},
  };
}

function normaliseV4(parsed: Partial<ProvidersConfig>): ProvidersConfig {
  return {
    schemaVersion: SCHEMA_VERSION,
    connections: parsed.connections ?? [],
    starred: parsed.starred ?? [],
    local: {
      downloaded: parsed.local?.downloaded ?? [],
      lastActivatedKey: parsed.local?.lastActivatedKey,
    },
    active: parsed.active ?? {},
  };
}

export async function loadProvidersConfig(
  files: FilesApi,
  systemFolder: string,
): Promise<ProvidersConfig> {
  const text = await tryReadText(files, configPath(systemFolder));
  if (text === undefined) return { ...emptyProvidersConfig };
  try {
    const parsed = JSON.parse(text) as {
      schemaVersion?: number;
      [key: string]: unknown;
    };
    const version: number = parsed.schemaVersion ?? 1;
    if (version === 1) return migrateFromV1(parsed as V1Config);
    if (version === 2) return migrateFromV2(parsed as V2Config);
    if (version === 3) return migrateFromV3(parsed as V3Config);
    return normaliseV4(parsed as Partial<ProvidersConfig>);
  } catch {
    return { ...emptyProvidersConfig };
  }
}

export async function saveProvidersConfig(
  files: FilesApi,
  systemFolder: string,
  config: ProvidersConfig,
): Promise<void> {
  const path = configPath(systemFolder);
  const sanitised: ProvidersConfig = {
    schemaVersion: SCHEMA_VERSION,
    connections: config.connections.filter((c) => c.apiKey),
    starred: config.starred,
    local: {
      downloaded: config.local.downloaded,
      lastActivatedKey: config.local.lastActivatedKey,
    },
    active: config.active,
  };
  await writeText(files, path, JSON.stringify(sanitised, null, 2));
}
