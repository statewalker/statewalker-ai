import type { LocalModelConfig } from "@statewalker/ai-agent/models";
import type { FilesApi } from "@statewalker/webrun-files";
import { resolveMlcFiles } from "./mlc-resolver.js";

/**
 * WebLLM stores its downloaded artifacts in Cache API under three
 * scopes — `webllm/config`, `webllm/model`, and `webllm/wasm`. When
 * `engine.reload(modelId)` finds the response in one of those caches,
 * it returns immediately *without* issuing a network fetch — which
 * means our SW write-through never runs and the workspace
 * `FilesApi` stays empty for that model.
 *
 * This happens any time a model was downloaded before the SW bridge
 * was installed, or in any other browser session, or by a different
 * app on the same origin. The result: model is "Active" in chat-mini
 * but no files are visible under `<workspace>/.settings/models/...`.
 *
 * `syncWeightsFromCache` walks the expected file list (the same list
 * `resolveMlcFiles` returns) and, for each entry missing from
 * FilesApi, copies the bytes from whichever WebLLM Cache API scope
 * holds them. Best-effort: any failure (cache miss, write error)
 * is logged and skipped — the model is already loaded in memory, so
 * a partial sync still leaves the chat usable; the next activation
 * will retry.
 */
export async function syncWeightsFromCache(
  modelId: string,
  config: LocalModelConfig,
  files: FilesApi | undefined,
  basePath: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!files) return;
  if (typeof caches === "undefined") return;

  let fileEntries: Awaited<ReturnType<typeof resolveMlcFiles>>;
  try {
    fileEntries = await resolveMlcFiles(modelId, config, signal);
  } catch (error) {
    console.warn("[webllm] syncWeightsFromCache: failed to resolve file list", modelId, error);
    return;
  }

  const baseUrl = modelId.startsWith("http")
    ? modelId.endsWith("/")
      ? modelId
      : `${modelId}/`
    : `https://huggingface.co/${modelId}/resolve/main/`;

  // Open all three WebLLM cache scopes; we don't know in advance
  // which scope holds each file (config vs model vs wasm).
  const scopes = ["webllm/config", "webllm/model", "webllm/wasm"];
  const cacheList = await Promise.all(
    scopes.map(async (s) => {
      try {
        return await caches.open(s);
      } catch {
        return null;
      }
    }),
  );

  let synced = 0;
  let skipped = 0;
  let missing = 0;

  for (const entry of fileEntries) {
    if (signal?.aborted) return;
    const localPath = `${basePath}/${modelId}/${entry.name}`;

    // Already on disk — leave it alone.
    try {
      const stat = await files.stats(localPath);
      if (stat && (stat.size ?? 0) > 0) {
        skipped += 1;
        continue;
      }
    } catch {
      /* fall through to write */
    }

    // Wasm lives at a different URL (the LIB_PREFIX on GitHub Raw),
    // so it has its own cache key. Everything else is keyed under
    // the HF model URL.
    const isWasm = entry.name.endsWith(".wasm");
    const url = isWasm ? config.mlcModelLib : `${baseUrl}${entry.name}`;
    if (!url) {
      missing += 1;
      continue;
    }

    let response: Response | undefined;
    for (const cache of cacheList) {
      if (!cache) continue;
      try {
        const hit = await cache.match(url);
        if (hit) {
          response = hit;
          break;
        }
      } catch {
        /* try next */
      }
    }
    if (!response) {
      missing += 1;
      continue;
    }

    try {
      const blob = await response.blob();
      await files.write(localPath, asyncChunksOf(blob));
      synced += 1;
    } catch (error) {
      console.warn("[webllm] syncWeightsFromCache: write failed", localPath, error);
    }
  }

  if (synced > 0 || missing > 0) {
    console.log("[webllm] syncWeightsFromCache", {
      modelId,
      synced,
      skipped,
      missing,
    });
  }
}

async function* asyncChunksOf(blob: Blob): AsyncIterable<Uint8Array> {
  const reader = blob.stream().getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
