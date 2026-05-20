import { type FilesApi, tryReadText, writeText } from "@statewalker/webrun-files";

const SCHEMA_VERSION = 5;
const PROVIDERS_FILENAME = "providers.json";

/** Connection type. Matches the canonical Vercel-AI-SDK providers
 * plus the generic OpenAI-compatible escape hatch for proxies and
 * self-hosted endpoints. */
export type ConnectionType = "openai" | "anthropic" | "google" | "openai-compatible";

/** A model's functional role tag. Resolved by a curated table; not
 * derived from server responses. Models with no match default to
 * `["chat"]`. `chat` is the gate the composer dropdown filters on. */
export type Capability = "chat" | "embedding" | "image-gen" | "tts";

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
  /** URL override. Required for `openai-compatible` (the endpoint
   * *is* the configuration) AND for `anthropic` (Anthropic's API
   * disables CORS so direct browser calls are blocked — a proxy
   * URL is mandatory in browser deployments). Optional for
   * `openai` and `google` (used only as a proxy override). */
  url?: string;
  apiKey: string;
  headers?: ConnectionHeader[];
  /** Cached `/v1/models` response. Populated by the Connect /
   * Check Connection lifecycle action in `models-config`. */
  discoveredModels?: DiscoveredModel[];
  /** Unix-ms timestamp of the last successful refresh. */
  discoveredAt?: number;
  /** Per-Connection starred set — model ids the user has checked
   * in Settings for chat use. Replaces v4's top-level
   * `starred: StarredRef[]`. */
  starredModelIds: string[];
}

/** A starred model — kept exported during v5 transition for legacy
 * downstream code; new code reads `Connection.starredModelIds`
 * directly. Will be removed once §5/§7 migration is complete. */
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
  local: { downloaded: [] },
  active: {},
};

/** Derived predicate: a Connection is "connected" iff its discovery
 * cache is populated (which the implementation maintains as
 * equivalent to `apiKey !== ""`). Disconnected shells produce no
 * `providers:remote` contribution. */
export function isConnected(c: Connection): boolean {
  return c.discoveredModels !== undefined;
}

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
      starredModelIds: [],
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
      starredModelIds: [],
    });
  }
  return out;
}

/** v4 fixture shape — never shipped, lived only in dev branches
 * during the in-flight `add-models-config-fragment` change.
 * Distinguished from v5 by its top-level `starred: StarredRef[]`. */
interface V4Config {
  schemaVersion: 4;
  connections?: Array<Omit<Connection, "starredModelIds"> & { starredModelIds?: string[] }>;
  starred?: StarredRef[];
  local?: { downloaded?: LocalModelRef[]; lastActivatedKey?: string };
  active?: { providerId?: string; modelId?: string };
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
    local: {
      downloaded: [],
      lastActivatedKey: parsed.local?.lastActivatedKey,
    },
    active: parsed.active ?? {},
  };
}

/** v4 → v5 migration. Fans the top-level `starred: StarredRef[]`
 * array into each Connection's `starredModelIds`. Orphan entries
 * (referencing unknown connectionIds) are silently dropped. */
function migrateFromV4(parsed: V4Config): ProvidersConfig {
  const connections: Connection[] = (parsed.connections ?? []).map((c) => ({
    ...(c as Connection),
    starredModelIds: c.starredModelIds ?? [],
  }));
  for (const ref of parsed.starred ?? []) {
    const target = connections.find((c) => c.id === ref.connectionId);
    if (!target) continue;
    if (!target.starredModelIds.includes(ref.modelId)) {
      target.starredModelIds.push(ref.modelId);
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    connections,
    local: {
      downloaded: parsed.local?.downloaded ?? [],
      lastActivatedKey: parsed.local?.lastActivatedKey,
    },
    active: parsed.active ?? {},
  };
}

function normaliseV5(parsed: Partial<ProvidersConfig>): ProvidersConfig {
  return {
    schemaVersion: SCHEMA_VERSION,
    connections: (parsed.connections ?? []).map((c) => ({
      ...c,
      starredModelIds: c.starredModelIds ?? [],
    })),
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
    if (version === 4) return migrateFromV4(parsed as V4Config);
    return normaliseV5(parsed as Partial<ProvidersConfig>);
  } catch {
    return { ...emptyProvidersConfig };
  }
}

/** Type-conditional URL validation for the connection form / Connect
 * action. Throws when a Connection lacks the URL required by its
 * type (Anthropic for CORS reasons, OpenAI-compatible because the
 * URL is the configuration).
 *
 * Storage (`saveProvidersConfig`) does NOT call this — dormant shells
 * and v3→v5 migrated Connections may legitimately lack a URL. The
 * Connect action handler invokes this before firing `listModels`,
 * surfacing the rejection inline in the form. */
export function validateConnectionUrl(c: Connection): void {
  const urlRequired = c.type === "anthropic" || c.type === "openai-compatible";
  if (urlRequired && (!c.url || c.url.trim() === "")) {
    const reason =
      c.type === "anthropic"
        ? "Anthropic requires a proxy URL — direct browser calls are blocked by CORS"
        : "OpenAI-compatible requires a URL — the endpoint is the configuration";
    throw new Error(`URL required for ${c.type} Connection (${c.name}): ${reason}`);
  }
}

export async function saveProvidersConfig(
  files: FilesApi,
  systemFolder: string,
  config: ProvidersConfig,
): Promise<void> {
  const path = configPath(systemFolder);
  // Sanitise: keep dormant shells (apiKey === "") so re-connect is
  // a one-click flow; defend against partial records by ensuring
  // `starredModelIds` is always present. URL validation lives in
  // the form/Connect layer (see `validateConnectionUrl`), not here.
  const sanitised: ProvidersConfig = {
    schemaVersion: SCHEMA_VERSION,
    connections: config.connections.map((c) => ({
      ...c,
      starredModelIds: c.starredModelIds ?? [],
    })),
    local: {
      downloaded: config.local.downloaded,
      lastActivatedKey: config.local.lastActivatedKey,
    },
    active: config.active,
  };
  await writeText(files, path, JSON.stringify(sanitised, null, 2));
}
