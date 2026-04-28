import type {
  ActivationProgress,
  LocalModelConfig,
  ModelKind,
  ModelRuntime,
  ModelStatus,
  ProviderName,
  RemoteProviderSettings,
} from "@statewalker/ai-provider";

export type { ActivationProgress, ModelKind, ModelRuntime, ModelStatus, ProviderName };

/**
 * Role a model is activated for. Independent slots — `reasoning` and
 * `embedding` are separately activatable. UI exposes them separately.
 */
export type ModelRole = "reasoning" | "embedding";

/**
 * Descriptor for a configured provider connection. Source of truth for
 * the provider list panel + the providers-changed broadcast.
 */
export interface ProviderDescriptor {
  /** Stable identifier — typically the canonical provider name (`anthropic`, `openai`, `google`) or a custom slug for OpenAI-compatible endpoints. */
  readonly providerId: string;
  /** Optional secondary id for multi-instance providers (e.g. multiple OpenAI-compatible endpoints). */
  readonly instanceId?: string;
  /** Provider type — drives default models / SDK selection. */
  readonly providerName: ProviderName;
  /** Human-readable label for UI. */
  readonly label: string;
  /** Where the provider runs — `remote` (HTTP API) or `local` (in-process engine). */
  readonly runtime: ModelRuntime;
  /** True if `RemoteProviderSettings.apiKey` (or equivalent) is set. */
  readonly hasCredentials: boolean;
}

/**
 * Descriptor for an individual model — single source of truth for UI
 * model lists. Includes per-role active flags so the picker can show
 * which model is currently bound to each role.
 */
export interface ModelDescriptor {
  /** Catalog key — globally unique identifier for the model. */
  readonly catalogKey: string;
  /** Human-readable label. */
  readonly label: string;
  /** Provider this model belongs to. */
  readonly providerId: string;
  /** Optional provider-instance id. */
  readonly instanceId?: string;
  /** Where the model runs. */
  readonly runtime: ModelRuntime;
  /** Roles this model is eligible for. */
  readonly kinds: readonly ModelKind[];
  /** Current download / load status. */
  readonly status: ModelStatus;
  /** Approximate model size in bytes (local models). */
  readonly sizeBytes?: number;
  /** Embedding dimensions (embedding models). */
  readonly dimensions?: number;
  /** Context window in tokens. */
  readonly contextWindow?: number;
  /** True if currently active for the reasoning role. */
  readonly isActiveReasoning: boolean;
  /** True if currently active for the embedding role. */
  readonly isActiveEmbedding: boolean;
}

/**
 * Per-engine storage info — used by the configurator UI to show
 * available disk space, total downloaded bytes, etc.
 */
export interface StorageInfo {
  readonly engineId: string;
  readonly totalBytes: number;
  readonly modelCount: number;
}

export type { LocalModelConfig, RemoteProviderSettings };
