import type { Intents } from "@statewalker/shared-intents";
import { newRegistry } from "@statewalker/shared-registry";
import type { Workspace } from "@statewalker/workspace-api";
import {
  handleConfigureProvider,
  handleListProviders,
  handleRemoveProvider,
  runActiveModelChanged,
  runProvidersChanged,
} from "../../api/intents.js";
import type {
  ConfigureProviderSettings,
  ProviderDescriptor,
  ProviderName,
} from "../../api/types.js";
import type { ActiveEmbeddingModelImpl, ActiveReasoningModelImpl } from "../adapters.impl.js";
import { ActiveEmbeddingModel, ActiveReasoningModel, ProviderSettingsStore } from "../adapters.js";

/**
 * Internal storage shape for a configured provider. The
 * `ProviderSettingsStore` abstract token stores `unknown` values; we
 * cast on read with this shape and validate at write.
 */
interface StoredProviderEntry {
  providerId: string;
  instanceId?: string;
  providerName: ProviderName;
  label: string;
  apiKey?: string;
  authToken?: string;
  baseURL?: string;
  headers?: Record<string, string>;
}

/**
 * Build the ProviderSettingsStore key from providerId + optional
 * instanceId. Multi-instance providers (e.g. multiple OpenAI-compatible
 * endpoints) share the same providerId; the instanceId disambiguates.
 */
function storageKey(providerId: string, instanceId?: string): string {
  return instanceId ? `${providerId}#${instanceId}` : providerId;
}

function isStoredEntry(value: unknown): value is StoredProviderEntry {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.providerId === "string" &&
    typeof v.providerName === "string" &&
    typeof v.label === "string"
  );
}

function entryToDescriptor(entry: StoredProviderEntry): ProviderDescriptor {
  return {
    providerId: entry.providerId,
    instanceId: entry.instanceId,
    providerName: entry.providerName,
    label: entry.label,
    runtime: "remote",
    hasCredentials: Boolean(entry.apiKey || entry.authToken),
  };
}

async function listAllEntries(store: ProviderSettingsStore): Promise<StoredProviderEntry[]> {
  const keys = await store.list();
  const out: StoredProviderEntry[] = [];
  for (const key of keys) {
    const value = await store.get(key);
    if (isStoredEntry(value)) out.push(value);
  }
  return out;
}

async function listAllDescriptors(store: ProviderSettingsStore): Promise<ProviderDescriptor[]> {
  const entries = await listAllEntries(store);
  return entries.map(entryToDescriptor);
}

function validateConfigureSettings(settings: ConfigureProviderSettings): string | undefined {
  if (typeof settings !== "object" || settings === null) {
    return "settings must be an object";
  }
  if (typeof settings.providerName !== "string" || !settings.providerName) {
    return "settings.providerName is required";
  }
  if (typeof settings.label !== "string" || !settings.label) {
    return "settings.label is required";
  }
  return undefined;
}

/**
 * Register the four provider-management intent handlers on the workspace.
 * Returns a cleanup that unregisters all of them.
 */
export function registerProviderHandlers(workspace: Workspace, intents: Intents): () => void {
  const [register, cleanup] = newRegistry();
  const store = workspace.requireAdapter(ProviderSettingsStore);

  register(
    handleListProviders(intents, (intent) => {
      void (async () => {
        try {
          const descriptors = await listAllDescriptors(store);
          const filter = intent.payload?.runtime;
          intent.resolve(filter ? descriptors.filter((d) => d.runtime === filter) : descriptors);
        } catch (err) {
          intent.reject(err);
        }
      })();
      return true;
    }),
  );

  register(
    handleConfigureProvider(intents, (intent) => {
      void (async () => {
        try {
          const error = validateConfigureSettings(intent.payload.settings);
          if (error) {
            intent.resolve({ ok: false, error });
            return;
          }
          const entry: StoredProviderEntry = {
            providerId: intent.payload.providerId,
            instanceId: intent.payload.instanceId,
            providerName: intent.payload.settings.providerName,
            label: intent.payload.settings.label,
            apiKey: intent.payload.settings.apiKey,
            authToken: intent.payload.settings.authToken,
            baseURL: intent.payload.settings.baseURL,
            headers: intent.payload.settings.headers,
          };
          await store.set(storageKey(entry.providerId, entry.instanceId), entry);
          // Broadcast BEFORE resolve so awaiters of runConfigureProvider
          // observe the broadcast already happened by the time their await
          // resumes (microtask ordering).
          const descriptors = await listAllDescriptors(store);
          runProvidersChanged(intents, descriptors);
          intent.resolve({ ok: true });
        } catch (err) {
          intent.resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      })();
      return true;
    }),
  );

  register(
    handleRemoveProvider(intents, (intent) => {
      void (async () => {
        try {
          const { providerId, instanceId } = intent.payload;
          const removed = await store.delete(storageKey(providerId, instanceId));
          if (removed) {
            // Cascade: clear active models that belonged to the removed provider.
            const activeReasoning = workspace.requireAdapter(ActiveReasoningModel);
            const activeEmbedding = workspace.requireAdapter(ActiveEmbeddingModel);
            if (activeReasoning.providerId === providerId) {
              (activeReasoning as ActiveReasoningModelImpl).setReasoning(
                undefined,
                undefined,
                undefined,
              );
              runActiveModelChanged(intents, { role: "reasoning", catalogKey: undefined });
            }
            if (activeEmbedding.providerId === providerId) {
              (activeEmbedding as ActiveEmbeddingModelImpl).setEmbedding(
                undefined,
                undefined,
                undefined,
              );
              runActiveModelChanged(intents, { role: "embedding", catalogKey: undefined });
            }
            const descriptors = await listAllDescriptors(store);
            runProvidersChanged(intents, descriptors);
          }
          intent.resolve();
        } catch (err) {
          intent.reject(err);
        }
      })();
      return true;
    }),
  );

  return cleanup;
}
