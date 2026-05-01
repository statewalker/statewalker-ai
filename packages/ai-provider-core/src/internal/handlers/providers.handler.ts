import type { Intents } from "@statewalker/shared-intents";
import { newRegistry } from "@statewalker/shared-registry";
import type { Workspace } from "@statewalker/workspace-api";
import {
  ActiveEmbeddingModel,
  ActiveReasoningModel,
  ProviderSettingsStore,
} from "../../public/adapters.js";
import {
  handleConfigureProvider,
  handleListProviders,
  handleRemoveProvider,
  runActiveModelChanged,
  runProvidersChanged,
} from "../../public/intents.js";
import type {
  ConfigureProviderSettings,
  ProviderDescriptor,
  ProviderName,
} from "../../public/types.js";
import type { ActiveEmbeddingModelImpl, ActiveReasoningModelImpl } from "../adapters.impl.js";

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
  selectedModelIds?: string[];
  enabled?: boolean;
}

/** Local engines stored under a separate `local#${engineId}` key prefix so
 *  they don't appear in the remote-providers list. */
const LOCAL_ENGINES = new Set(["tjs", "webllm", "llamacpp"]);

function isLocalEngine(providerId: string): boolean {
  return LOCAL_ENGINES.has(providerId);
}

/**
 * Build the ProviderSettingsStore key from providerId + optional
 * instanceId. Multi-instance providers (e.g. multiple OpenAI-compatible
 * endpoints) share the same providerId; the instanceId disambiguates.
 * Local engines use the `local#${engineId}` prefix.
 */
function storageKey(providerId: string, instanceId?: string): string {
  if (isLocalEngine(providerId)) return `local#${providerId}`;
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
    if (key.startsWith("local#")) continue; // local engine settings are not "providers"
    const value = await store.get(key);
    if (isStoredEntry(value)) out.push(value);
  }
  return out;
}

async function listAllDescriptors(store: ProviderSettingsStore): Promise<ProviderDescriptor[]> {
  const entries = await listAllEntries(store);
  return entries.map(entryToDescriptor);
}

function validateConfigureSettings(
  settings: ConfigureProviderSettings,
  providerId: string,
): string | undefined {
  if (typeof settings !== "object" || settings === null) {
    return "settings must be an object";
  }
  // For local engines we don't require providerName/label — the engine id
  // is sufficient and labels come from the catalog.
  if (isLocalEngine(providerId)) return undefined;
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
          const error = validateConfigureSettings(
            intent.payload.settings,
            intent.payload.providerId,
          );
          if (error) {
            intent.resolve({ ok: false, error });
            return;
          }
          const settings = intent.payload.settings;
          const entry: StoredProviderEntry = {
            providerId: intent.payload.providerId,
            instanceId: intent.payload.instanceId,
            providerName: settings.providerName,
            label: settings.label,
            apiKey: settings.apiKey,
            authToken: settings.authToken,
            baseURL: settings.baseURL,
            headers: settings.headers,
          };
          if (settings.selectedModelIds !== undefined) {
            entry.selectedModelIds = [...settings.selectedModelIds];
          }
          if (settings.enabled !== undefined) {
            entry.enabled = settings.enabled;
          }
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
