import type { EngineId, ModelStateStore } from "@statewalker/ai-provider";
import { type FilesApi, readText } from "@statewalker/webrun-files";

const MODELS_DIR = "/.settings/models";

interface DownloadedMetadata {
  status: "downloaded";
  modelId: string;
  engine?: EngineId;
  downloadedAt: string;
}

interface PartialMetadata {
  status: "partial";
  modelId: string;
  engine?: EngineId;
  bytesDownloaded: number;
  bytesTotal: number;
  updatedAt: string;
}

type DownloadMetadata = DownloadedMetadata | PartialMetadata;

function metadataPath(catalogKey: string): string {
  return `${MODELS_DIR}/${catalogKey}.json`;
}

/** Persist download completion or partial status to /.settings/models/{catalogKey}.json. */
export async function persistDownloadStatus(
  files: FilesApi,
  catalogKey: string,
  modelId: string,
  status: "downloaded" | "partial",
  progress?: { bytesDownloaded: number; bytesTotal: number },
  engine?: EngineId,
): Promise<void> {
  await files.mkdir(MODELS_DIR);
  const metadata: DownloadMetadata =
    status === "downloaded"
      ? { status, modelId, engine, downloadedAt: new Date().toISOString() }
      : {
          status,
          modelId,
          engine,
          bytesDownloaded: progress?.bytesDownloaded ?? 0,
          bytesTotal: progress?.bytesTotal ?? 0,
          updatedAt: new Date().toISOString(),
        };
  const content = JSON.stringify(metadata, null, 2);
  await files.write(metadataPath(catalogKey), [new TextEncoder().encode(content)]);
}

/** Remove download metadata for a model. */
export async function removeDownloadStatus(files: FilesApi, catalogKey: string): Promise<void> {
  await files.remove(metadataPath(catalogKey));
}

/** Scan /.settings/models/ on startup and restore download statuses into the store. */
export async function restoreDownloadStatuses(
  files: FilesApi,
  store: ModelStateStore,
): Promise<void> {
  if (!(await files.exists(MODELS_DIR))) return;

  for await (const entry of files.list(MODELS_DIR)) {
    if (entry.kind !== "file" || !entry.name.endsWith(".json")) continue;

    const catalogKey = entry.name.replace(/\.json$/, "");
    // Only restore for models that exist in the catalog
    if (!store.getState(catalogKey)) continue;

    try {
      const text = await readText(files, entry.path);
      const metadata = JSON.parse(text) as DownloadMetadata;
      if (metadata.status === "downloaded" || metadata.status === "partial") {
        // `metadata.engine` is read for diagnostics; legacy entries default
        // to "tjs". The store's effective engine always comes from the
        // current catalog entry — this value is informational only.
        store.setStatus(catalogKey, metadata.status);
      }
    } catch {
      // Skip unreadable metadata
    }
  }
}
