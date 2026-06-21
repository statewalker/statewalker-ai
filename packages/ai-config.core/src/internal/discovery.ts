import type { Connection, ConnectionHeader, DiscoveredModel } from "../public/types.js";

const MAX_ERROR_BODY = 512;

async function asError(response: Response): Promise<Error> {
  let body = "";
  try {
    body = await response.text();
  } catch {
    body = "";
  }
  const truncated = body.length > MAX_ERROR_BODY ? `${body.slice(0, MAX_ERROR_BODY)}…` : body;
  return new Error(
    `${response.status} ${response.statusText}${truncated ? ` — ${truncated}` : ""}`,
  );
}

function applyHeaders(init: HeadersInit, extra: ConnectionHeader[] | undefined): HeadersInit {
  if (!extra || extra.length === 0) return init;
  const merged = new Headers(init);
  for (const h of extra) {
    if (h.name) merged.set(h.name, h.value);
  }
  return merged;
}

async function listOpenAIModels(c: Connection, apiKey: string): Promise<DiscoveredModel[]> {
  const base = (c.url ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const res = await fetch(`${base}/models`, {
    method: "GET",
    headers: applyHeaders({ Authorization: `Bearer ${apiKey}` }, c.headers),
  });
  if (!res.ok) throw await asError(res);
  const json = (await res.json()) as { data?: Array<{ id: string }> };
  return (json.data ?? []).map((m) => ({ id: m.id, label: m.id }));
}

async function listAnthropicModels(c: Connection, apiKey: string): Promise<DiscoveredModel[]> {
  const base = (c.url ?? "https://api.anthropic.com").replace(/\/+$/, "");
  const res = await fetch(`${base}/v1/models`, {
    method: "GET",
    headers: applyHeaders({ "x-api-key": apiKey, "anthropic-version": "2023-06-01" }, c.headers),
  });
  if (!res.ok) throw await asError(res);
  const json = (await res.json()) as { data?: Array<{ id: string; display_name?: string }> };
  return (json.data ?? []).map((m) => ({ id: m.id, label: m.display_name ?? m.id }));
}

async function listGoogleModels(c: Connection, apiKey: string): Promise<DiscoveredModel[]> {
  const base = (c.url ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
  const res = await fetch(`${base}/models?key=${encodeURIComponent(apiKey)}`, {
    method: "GET",
    headers: applyHeaders({}, c.headers),
  });
  if (!res.ok) throw await asError(res);
  const json = (await res.json()) as {
    models?: Array<{ name: string; displayName?: string; supportedGenerationMethods?: string[] }>;
  };
  return (json.models ?? [])
    .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
    .map((m) => ({
      id: m.name.replace(/^models\//, ""),
      label: m.displayName ?? m.name.replace(/^models\//, ""),
    }));
}

async function listOpenAICompatibleModels(
  c: Connection,
  apiKey: string,
): Promise<DiscoveredModel[]> {
  if (!c.url) throw new Error("openai-compatible Connection requires a url");
  const base = c.url.replace(/\/+$/, "");
  const init: HeadersInit = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const res = await fetch(`${base}/models`, {
    method: "GET",
    headers: applyHeaders(init, c.headers),
  });
  if (!res.ok) throw await asError(res);
  const json = (await res.json()) as { data?: Array<{ id: string }> };
  return (json.data ?? []).map((m) => ({ id: m.id, label: m.id }));
}

/**
 * Fetch the model list for a Connection, using a key supplied by the caller
 * (read from `Secrets`). Throws on non-2xx / network failure.
 */
export function listConnectionModels(c: Connection, apiKey: string): Promise<DiscoveredModel[]> {
  switch (c.type) {
    case "openai":
      return listOpenAIModels(c, apiKey);
    case "anthropic":
      return listAnthropicModels(c, apiKey);
    case "google":
      return listGoogleModels(c, apiKey);
    case "openai-compatible":
      return listOpenAICompatibleModels(c, apiKey);
  }
}
