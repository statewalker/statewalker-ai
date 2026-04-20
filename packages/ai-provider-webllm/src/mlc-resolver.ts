import type { LocalModelConfig } from "@statewalker/ai-provider";

interface NdarrayCache {
  records?: Array<{ dataPath: string; format?: string; nbytes?: number }>;
}

interface MlcChatConfig {
  tokenizer_files?: string[];
  [key: string]: unknown;
}

/**
 * HuggingFace base URL for a model (accepts the four forms WebLLM itself
 * accepts: with/without trailing slash, main or explicit resolve path).
 */
function modelBaseUrl(modelId: string): string {
  // Accept either a bare "owner/repo" or a full https URL.
  if (modelId.startsWith("http://") || modelId.startsWith("https://")) {
    return modelId.endsWith("/") ? modelId : `${modelId}/`;
  }
  return `https://huggingface.co/${modelId}/resolve/main/`;
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

async function head(url: string, signal?: AbortSignal): Promise<number> {
  try {
    const res = await fetch(url, { method: "HEAD", signal });
    if (!res.ok) return 0;
    return Number.parseInt(res.headers.get("content-length") ?? "0", 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Resolve the full list of files WebLLM needs for a model: config,
 * ndarray cache, tensor shards, tokenizer files, and the wasm library.
 * Sizes come from ndarray-cache `nbytes` for shards and HEAD requests for
 * the rest; zero is acceptable (`LocalModelStorage` falls back to
 * `config.sizeBytes`).
 */
export async function resolveMlcFiles(
  modelId: string,
  config: LocalModelConfig,
  signal?: AbortSignal,
): Promise<Array<{ name: string; size: number }>> {
  const base = modelBaseUrl(modelId);
  const files: Array<{ name: string; size: number }> = [];

  // 1. mlc-chat-config.json
  const chatConfig = await fetchJson<MlcChatConfig>(
    `${base}mlc-chat-config.json`,
    signal,
  );
  files.push({
    name: "mlc-chat-config.json",
    size: await head(`${base}mlc-chat-config.json`, signal),
  });

  // 2. ndarray-cache.json + its shards
  const ndarrayCache = await fetchJson<NdarrayCache>(
    `${base}ndarray-cache.json`,
    signal,
  );
  files.push({
    name: "ndarray-cache.json",
    size: await head(`${base}ndarray-cache.json`, signal),
  });
  const shardNames = new Set<string>();
  for (const record of ndarrayCache.records ?? []) {
    if (record.dataPath) shardNames.add(record.dataPath);
  }
  for (const shard of shardNames) {
    const record = ndarrayCache.records?.find((r) => r.dataPath === shard);
    files.push({ name: shard, size: record?.nbytes ?? 0 });
  }

  // 3. tokenizer files — prefer tokenizer.json when listed
  const tokenizerFiles = chatConfig.tokenizer_files ?? ["tokenizer.json"];
  for (const tok of tokenizerFiles) {
    files.push({ name: tok, size: await head(`${base}${tok}`, signal) });
  }

  // 4. model library (.wasm) — stored next to other artifacts for offline use
  if (config.mlcModelLib) {
    const wasmUrl = config.mlcModelLib;
    const name = wasmUrl.split("/").pop() ?? "model.wasm";
    files.push({
      name,
      size: await head(wasmUrl, signal),
    });
  }

  return files;
}

/**
 * Predicate for `LocalModelStorage.hasWeights` — checks for the MLC
 * signature files (config + ndarray cache + at least one shard).
 */
export async function verifyMlcWeights(
  entries: AsyncIterable<{ kind: string; name: string }>,
): Promise<boolean> {
  let hasConfig = false;
  let hasCache = false;
  let hasShard = false;
  for await (const entry of entries) {
    if (entry.kind !== "file") continue;
    if (entry.name === "mlc-chat-config.json") hasConfig = true;
    else if (entry.name === "ndarray-cache.json") hasCache = true;
    else if (
      entry.name.startsWith("params_shard_") &&
      entry.name.endsWith(".bin")
    )
      hasShard = true;
  }
  return hasConfig && hasCache && hasShard;
}
