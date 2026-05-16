import type { Connection, ConnectionHeader, DiscoveredModel } from "./providers-store.js";

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

async function listOpenAIModels(c: Connection): Promise<DiscoveredModel[]> {
  const base = (c.url ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const res = await fetch(`${base}/models`, {
    method: "GET",
    headers: applyHeaders({ Authorization: `Bearer ${c.apiKey}` }, c.headers),
  });
  if (!res.ok) throw await asError(res);
  const json = (await res.json()) as { data?: Array<{ id: string }> };
  return (json.data ?? []).map((m) => ({ id: m.id, label: m.id }));
}

async function listAnthropicModels(c: Connection): Promise<DiscoveredModel[]> {
  const base = (c.url ?? "https://api.anthropic.com").replace(/\/+$/, "");
  const res = await fetch(`${base}/v1/models`, {
    method: "GET",
    headers: applyHeaders(
      {
        "x-api-key": c.apiKey,
        "anthropic-version": "2023-06-01",
      },
      c.headers,
    ),
  });
  if (!res.ok) throw await asError(res);
  const json = (await res.json()) as {
    data?: Array<{ id: string; display_name?: string }>;
  };
  return (json.data ?? []).map((m) => ({
    id: m.id,
    label: m.display_name ?? m.id,
  }));
}

async function listGoogleModels(c: Connection): Promise<DiscoveredModel[]> {
  const base = (c.url ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
  const url = `${base}/models?key=${encodeURIComponent(c.apiKey)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: applyHeaders({}, c.headers),
  });
  if (!res.ok) throw await asError(res);
  const json = (await res.json()) as {
    models?: Array<{
      name: string;
      displayName?: string;
      supportedGenerationMethods?: string[];
    }>;
  };
  return (json.models ?? [])
    .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
    .map((m) => ({
      id: m.name.replace(/^models\//, ""),
      label: m.displayName ?? m.name.replace(/^models\//, ""),
    }));
}

async function listOpenAICompatibleModels(c: Connection): Promise<DiscoveredModel[]> {
  if (!c.url) {
    throw new Error("openai-compatible Connection requires a url");
  }
  const base = c.url.replace(/\/+$/, "");
  const init: HeadersInit = c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {};
  const res = await fetch(`${base}/models`, {
    method: "GET",
    headers: applyHeaders(init, c.headers),
  });
  if (!res.ok) throw await asError(res);
  const json = (await res.json()) as { data?: Array<{ id: string }> };
  return (json.data ?? []).map((m) => ({ id: m.id, label: m.id }));
}

/**
 * Fetch the model list for a Connection. Throws on non-2xx or
 * network failure — the message includes HTTP status and a truncated
 * body excerpt.
 */
export async function listConnectionModels(c: Connection): Promise<DiscoveredModel[]> {
  switch (c.type) {
    case "openai":
      return listOpenAIModels(c);
    case "anthropic":
      return listAnthropicModels(c);
    case "google":
      return listGoogleModels(c);
    case "openai-compatible":
      return listOpenAICompatibleModels(c);
  }
}
