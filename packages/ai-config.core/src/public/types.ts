/**
 * Connection type — the canonical Vercel-AI-SDK providers plus the generic
 * OpenAI-compatible escape hatch for proxies and self-hosted endpoints.
 */
export type ConnectionType = "openai" | "anthropic" | "google" | "openai-compatible";

/** A model's functional role tag. Resolved by a curated table; not derived
 * from server responses. Models with no match default to `["chat"]`. */
export type Capability = "chat" | "embedding" | "image-gen" | "tts";

/** A discovered model entry cached on a Connection by the refresh flow. */
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

/**
 * A remote model-provider endpoint. Credential-free: the API key lives in the
 * `Secrets` adapter keyed `ai.connection.<id>.apiKey`, never here. Multiple
 * Connections of the same canonical `type` are allowed (e.g. work + personal).
 */
export interface Connection {
  /** Stable id. */
  id: string;
  type: ConnectionType;
  /** Display label. */
  name: string;
  /** URL override. Required for `openai-compatible` (the endpoint is the
   * configuration) and for `anthropic` in the browser (CORS). Optional for
   * `openai`/`google` (proxy override). */
  url?: string;
  /** Headers forwarded on every outgoing call. */
  headers?: ConnectionHeader[];
  /** Cached `/v1/models` discovery response. */
  discoveredModels?: DiscoveredModel[];
  /** Unix-ms timestamp of the last successful refresh. */
  discoveredAt?: number;
  /** Per-Connection starred model ids (chat-curated). */
  starredModelIds: string[];
}

/** A downloaded local model registered into the config by the local-model
 * lifecycle package (its loading is out of scope for ai.config). */
export interface LocalModelRef {
  key: string;
  downloadedAt: number;
}

/** The active model selection (chat). `connectionId` may be the literal
 * `"local"` for a local model. */
export interface ActiveSelection {
  connectionId?: string;
  modelId?: string;
}

/** The persisted, credential-free AI configuration document. */
export interface AiConfigData {
  schemaVersion: number;
  connections: Connection[];
  local: { downloaded: LocalModelRef[]; lastActivatedKey?: string };
  active: ActiveSelection;
}

export const AI_CONFIG_SCHEMA_VERSION = 6;

export const emptyAiConfigData: AiConfigData = {
  schemaVersion: AI_CONFIG_SCHEMA_VERSION,
  connections: [],
  local: { downloaded: [] },
  active: {},
};
