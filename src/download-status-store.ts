import type { ModelStateStore } from "@statewalker/ai-provider";
import { type FilesApi, readText } from "@statewalker/webrun-files";

const MODELS_DIR = "/.settings/models";

interface DownloadedMetadata {
  status: "downloaded";
  modelId: string;
  downloadedAt: string;
}

interface PartialMetadata {
  status: "partial";
  modelId: string;
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
): Promise<void> {
  await files.mkdir(MODELS_DIR);
  const metadata: DownloadMetadata =
    status === "downloaded"
      ? { status, modelId, downloadedAt: new Date().toISOString() }
      : {
          status,
          modelId,
          bytesDownloaded: progress?.bytesDownloaded ?? 0,
          bytesTotal: progress?.bytesTotal ?? 0,
          updatedAt: new Date().toISOString(),
        };
  const content = JSON.stringify(metadata, null, 2);
  await files.write(metadataPath(catalogKey), [
    new TextEncoder().encode(content),
  ]);
}

/** Remove download metadata for a model. */
export async function removeDownloadStatus(
  files: FilesApi,
  catalogKey: string,
): Promise<void> {
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
        store.setStatus(catalogKey, metadata.status);
      }
    } catch {
      // Skip unreadable metadata
    }
  }
}
