import type { ProviderName, RemoteProviderSettings } from "./types.js";

/** One model entry returned by a provider's `/models` endpoint. */
export interface DiscoveredModel {
  /** Provider-specific model id (passed to `ModelManager.activate`). */
  id: string;
  /** Human-readable label (falls back to `id` when none provided). */
  label: string;
}

const MAX_ERROR_BODY = 512;

/**
 * Discover the list of models a remote provider exposes for the given
 * credentials. Never mutates persistent state. Throws `Error` with a
 * displayable message on non-OK HTTP or network failures.
 */
export async function listModels(
  provider: ProviderName,
  settings: RemoteProviderSettings,
): Promise<DiscoveredModel[]> {
  switch (provider) {
    case "anthropic":
      return listAnthropic(settings);
    case "google":
      return listGoogle(settings);
    case "openai":
      return listOpenAI(settings, "https://api.openai.com/v1");
    case "openai-compatible":
      if (!settings.baseURL) {
        throw new Error("openai-compatible provider requires baseURL");
      }
      return listOpenAI(settings, settings.baseURL);
    default:
      throw new Error(`Unknown provider: ${provider as string}`);
  }
}

async function listAnthropic(settings: RemoteProviderSettings): Promise<DiscoveredModel[]> {
  if (!settings.apiKey) throw new Error("anthropic requires settings.apiKey");
  const res = await fetch("https://api.anthropic.com/v1/models", {
    method: "GET",
    headers: {
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01",
    },
  });
  await assertOk(res, "anthropic");
  const json = (await res.json()) as {
    data?: Array<{ id?: string; display_name?: string }>;
  };
  return (json.data ?? [])
    .filter((m): m is { id: string; display_name?: string } => typeof m.id === "string")
    .map((m) => ({ id: m.id, label: m.display_name ?? m.id }));
}

async function listOpenAI(
  settings: RemoteProviderSettings,
  baseURL: string,
): Promise<DiscoveredModel[]> {
  const headers: Record<string, string> = {};
  if (settings.apiKey) {
    headers.Authorization = `Bearer ${settings.apiKey}`;
  }
  const url = `${baseURL.replace(/\/$/, "")}/models`;
  const res = await fetch(url, { method: "GET", headers });
  await assertOk(res, "openai");
  const json = (await res.json()) as {
    data?: Array<{ id?: string }>;
  };
  return (json.data ?? [])
    .filter((m): m is { id: string } => typeof m.id === "string")
    .map((m) => ({ id: m.id, label: m.id }));
}

async function listGoogle(settings: RemoteProviderSettings): Promise<DiscoveredModel[]> {
  if (!settings.apiKey) throw new Error("google requires settings.apiKey");
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(
    settings.apiKey,
  )}`;
  const res = await fetch(url, { method: "GET" });
  await assertOk(res, "google");
  const json = (await res.json()) as {
    models?: Array<{
      name?: string;
      displayName?: string;
      supportedGenerationMethods?: string[];
    }>;
  };
  return (json.models ?? [])
    .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
    .filter((m): m is { name: string; displayName?: string } => typeof m.name === "string")
    .map((m) => {
      // Google returns names like "models/gemini-2.5-pro" — strip the prefix.
      const id = m.name.startsWith("models/") ? m.name.slice(7) : m.name;
      return { id, label: m.displayName ?? id };
    });
}

async function assertOk(res: Response, provider: string): Promise<void> {
  if (res.ok) return;
  let body = "";
  try {
    body = await res.text();
  } catch {
    body = "";
  }
  const snippet = body.length > MAX_ERROR_BODY ? `${body.slice(0, MAX_ERROR_BODY)}…` : body;
  throw new Error(`${provider} /models HTTP ${res.status}: ${snippet}`);
}
