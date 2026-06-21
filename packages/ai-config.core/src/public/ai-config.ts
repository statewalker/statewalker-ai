import type { ProviderV3 } from "@ai-sdk/provider";
import type { ActiveSelection, Capability, Connection, DiscoveredModel } from "./types.js";

/** Stable Secrets key for a connection's API key. */
export function apiKeySecretKey(connectionId: string): string {
  return `ai.connection.${connectionId}.apiKey`;
}

/**
 * The unified AI-configuration adapter (workspace level). The single source of
 * truth for provider connections, discovered models, and the active selection.
 * Credential-free: API keys live in the `Secrets` adapter, read at
 * `getProvider` time. Both chat (`ActiveModel`) and wiki (`WikiLlmConfiguration`)
 * bind to this by id reference.
 */
export abstract class AiConfig {
  // ── reads ──────────────────────────────────────────────────────
  abstract listConnections(): Connection[];
  abstract getConnection(id: string): Connection | undefined;
  /** Cached discovered models for a connection, optionally filtered by capability. */
  abstract getModels(connectionId: string, capability?: Capability): DiscoveredModel[];
  /** Build a provider for a connection, reading its key from `Secrets`. */
  abstract getProvider(connectionId: string): Promise<ProviderV3>;
  abstract getActive(): ActiveSelection;
  /** Whether a non-empty API key is stored in `Secrets` for the connection.
   * Drives the remove-confirm gate (the secret worth protecting). */
  abstract hasKey(connectionId: string): Promise<boolean>;
  /** The stored API key for a connection (from `Secrets`), or `""` when none.
   * Used to populate the settings form so a saved key is visible/editable. */
  abstract getApiKey(connectionId: string): Promise<string>;
  abstract onUpdate(cb: () => void): () => void;

  // ── writes ─────────────────────────────────────────────────────
  /** Add or replace a connection. When `apiKey` is given, it is stored in `Secrets`. */
  abstract upsertConnection(
    connection: Omit<Connection, "discoveredModels" | "discoveredAt">,
    apiKey?: string,
  ): Promise<void>;
  /** Remove a connection and delete its secret. */
  abstract removeConnection(id: string): Promise<void>;
  /** Disconnect a connection: delete its stored key (`Secrets`) and clear its
   * `discoveredModels`, `discoveredAt`, and `starredModelIds`, keeping the
   * shell (id/type/name/url/headers) so the user can re-connect with one click. */
  abstract disconnect(connectionId: string): Promise<void>;
  /** Store/replace a connection's API key in `Secrets` (never in the config file). */
  abstract setApiKey(connectionId: string, apiKey: string): Promise<void>;
  /** Refresh a connection's discovered-models cache via the provider's model endpoint. */
  abstract refreshModels(connectionId: string): Promise<DiscoveredModel[]>;
  abstract setActive(connectionId: string, modelId: string): Promise<void>;
  abstract starModels(connectionId: string, modelIds: string[]): Promise<void>;
}
