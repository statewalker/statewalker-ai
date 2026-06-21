import { type FilesApi, tryReadText, writeText } from "@statewalker/webrun-files";
import {
  AI_CONFIG_SCHEMA_VERSION,
  type AiConfigData,
  type Connection,
  emptyAiConfigData,
} from "../public/types.js";

const FILENAME = "ai-config.json";

function configPath(systemFolder: string): string {
  const trimmed = systemFolder.replace(/^\/+|\/+$/g, "");
  return `/${trimmed}/${FILENAME}`;
}

/** Callback invoked once per connection that carried a legacy plaintext key,
 * so the manager can lift it into `Secrets`. */
export type OnLegacyKey = (connectionId: string, apiKey: string) => void;

/**
 * Load the credential-free AI config. Missing/corrupt → empty. Any connection
 * that carries a legacy plaintext `apiKey` (from the pre-v6 `providers.json`)
 * has its key reported via `onLegacyKey` and stripped from the returned data;
 * the schema is normalised to v6. Persisting the result (which has no keys)
 * makes the migration idempotent.
 */
export async function loadAiConfig(
  files: FilesApi,
  systemFolder: string,
  onLegacyKey?: OnLegacyKey,
): Promise<AiConfigData> {
  const text = await tryReadText(files, configPath(systemFolder));
  if (text === undefined) return structuredClone(emptyAiConfigData);
  let parsed: Partial<AiConfigData> & { connections?: Array<Connection & { apiKey?: string }> };
  try {
    parsed = JSON.parse(text);
  } catch {
    return structuredClone(emptyAiConfigData);
  }
  const connections: Connection[] = (parsed.connections ?? []).map((raw) => {
    const { apiKey, ...rest } = raw as Connection & { apiKey?: string };
    if (apiKey) onLegacyKey?.(rest.id, apiKey);
    return { ...rest, starredModelIds: rest.starredModelIds ?? [] };
  });
  return {
    schemaVersion: AI_CONFIG_SCHEMA_VERSION,
    connections,
    local: {
      downloaded: parsed.local?.downloaded ?? [],
      lastActivatedKey: parsed.local?.lastActivatedKey,
    },
    active: parsed.active ?? {},
  };
}

/** Persist the AI config. Credentials never reach this file — `Connection`
 * has no `apiKey`; keys live in `Secrets`. */
export async function saveAiConfig(
  files: FilesApi,
  systemFolder: string,
  data: AiConfigData,
): Promise<void> {
  const out: AiConfigData = {
    schemaVersion: AI_CONFIG_SCHEMA_VERSION,
    connections: data.connections.map((c) => ({ ...c, starredModelIds: c.starredModelIds ?? [] })),
    local: { downloaded: data.local.downloaded, lastActivatedKey: data.local.lastActivatedKey },
    active: data.active,
  };
  await writeText(files, configPath(systemFolder), JSON.stringify(out, null, 2));
}
