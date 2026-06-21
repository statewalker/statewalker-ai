import { Secrets, type Workspace } from "@statewalker/workspace.core";
import { AiConfig, apiKeySecretKey } from "./ai-config.js";
import type { ConnectionType } from "./types.js";

/** Provider env var → canonical connection. The connection id is the provider
 * type name (stable, one canonical connection per provider from env). */
const ENV_CONNECTIONS: ReadonlyArray<{
  env: string;
  id: string;
  type: ConnectionType;
  name: string;
}> = [
  { env: "OPENAI_API_KEY", id: "openai", type: "openai", name: "OpenAI" },
  { env: "ANTHROPIC_API_KEY", id: "anthropic", type: "anthropic", name: "Anthropic" },
  { env: "GOOGLE_GENERATIVE_AI_API_KEY", id: "google", type: "google", name: "Google" },
];

/**
 * Node-host fallback: for each known provider env var, seed the key into
 * `Secrets` **only when the secret store has no key** for that connection, and
 * register the connection in `AiConfig`. A stored secret always wins; env is
 * never read at provider-build time. Host-side only — the fragment never calls this.
 */
export async function seedAiConfigFromEnv(
  workspace: Workspace,
  env: Record<string, string | undefined>,
): Promise<void> {
  const secrets = workspace.requireAdapter(Secrets);
  const config = workspace.requireAdapter(AiConfig);
  for (const c of ENV_CONNECTIONS) {
    const value = env[c.env];
    if (!value) continue;
    const existing = await secrets.get(apiKeySecretKey(c.id));
    if (existing !== undefined) continue; // stored wins
    await secrets.set(apiKeySecretKey(c.id), value);
    if (!config.getConnection(c.id)) {
      await config.upsertConnection({ id: c.id, type: c.type, name: c.name, starredModelIds: [] });
    }
  }
}
