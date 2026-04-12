import type { FilesApi } from "@statewalker/webrun-files";
import type { ActivationProgress, LocalModelConfig } from "./types.js";

const METADATA_FILE = "model.json";
const HF_CDN = "https://huggingface.co";

/**
 * Manages local model files (weights, config, tokenizer) via FilesApi.
 * Handles downloading from HuggingFace CDN with progress and resume support.
 */
export class LocalModelStorage {
  readonly files: FilesApi;

  constructor(
    files: FilesApi,
    private readonly basePath = "/models",
  ) {
    this.files = files;
  }

  private modelDir(modelId: string): string {
    return `${this.basePath}/${modelId}`;
  }

  /** Check if model weights exist in storage. */
  async hasWeights(modelId: string): Promise<boolean> {
    const dir = this.modelDir(modelId);
    const meta = await this.files.stats(`${dir}/${METADATA_FILE}`);
    if (!meta) return false;

    // Check at least one .onnx or .onnx_data file exists
    for await (const entry of this.files.list(dir)) {
      if (
        entry.kind === "file" &&
        (entry.name.endsWith(".onnx") || entry.name.includes(".onnx_data"))
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Download model files from HuggingFace and store via FilesApi.
   * Yields ActivationProgress events during download.
   * Supports resume: checks existing file sizes and uses HTTP Range headers.
   */
  async *download(
    modelKey: string,
    modelId: string,
    config: LocalModelConfig,
    signal?: AbortSignal,
  ): AsyncGenerator<ActivationProgress> {
    const dir = this.modelDir(modelId);
    await this.files.mkdir(dir);

    // Resolve files to download from the model's file list
    const filesToDownload = await this.resolveModelFiles(modelId, signal);

    let totalBytes = 0;
    let downloadedBytes = 0;

    for (const file of filesToDownload) {
      totalBytes += file.size;
    }

    // Use config sizeBytes as fallback if we couldn't get actual sizes
    if (totalBytes === 0) {
      totalBytes = config.sizeBytes;
    }

    for (const file of filesToDownload) {
      signal?.throwIfAborted();

      const localPath = `${dir}/${file.name}`;

      // Check for existing partial download
      const existing = await this.files.stats(localPath);
      const existingSize = existing?.size ?? 0;

      if (existingSize > 0 && existingSize >= file.size) {
        // File already fully downloaded
        downloadedBytes += file.size;
        yield {
          modelKey,
          phase: "downloading",
          progress: totalBytes > 0 ? downloadedBytes / totalBytes : 0,
          bytesDownloaded: downloadedBytes,
          bytesTotal: totalBytes,
          message: `Skipped ${file.name} (already downloaded)`,
        };
        continue;
      }

      // Download with optional resume
      const url = `${HF_CDN}/${modelId}/resolve/main/${file.name}`;
      const headers: Record<string, string> = {};
      if (existingSize > 0) {
        headers.Range = `bytes=${existingSize}-`;
        downloadedBytes += existingSize;
      }

      const response = await fetch(url, { headers, signal });
      if (!response.ok && response.status !== 206) {
        throw new Error(
          `Failed to download ${file.name}: ${response.status} ${response.statusText}`,
        );
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error(`No response body for ${file.name}`);
      }

      // Stream chunks to FilesApi
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          signal?.throwIfAborted();
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          downloadedBytes += value.byteLength;

          yield {
            modelKey,
            phase: "downloading",
            progress: totalBytes > 0 ? downloadedBytes / totalBytes : 0,
            bytesDownloaded: downloadedBytes,
            bytesTotal: totalBytes,
            message: `Downloading ${file.name}`,
          };
        }
      } finally {
        reader.releaseLock();
      }

      // Write complete file to FilesApi
      await this.files.write(localPath, chunks);
    }

    // Save metadata
    const metaJson = JSON.stringify(config);
    await this.files.write(`${dir}/${METADATA_FILE}`, [
      new TextEncoder().encode(metaJson),
    ]);
  }

  /** Delete a model's files from storage. */
  async delete(modelId: string): Promise<void> {
    await this.files.remove(this.modelDir(modelId));
  }

  /** List all stored models by reading metadata files. */
  async listStored(): Promise<
    Array<{ modelId: string; config: LocalModelConfig }>
  > {
    const results: Array<{ modelId: string; config: LocalModelConfig }> = [];
    if (!(await this.files.exists(this.basePath))) return results;

    for await (const entry of this.files.list(this.basePath)) {
      if (entry.kind !== "directory") continue;
      const metaPath = `${entry.path}/${METADATA_FILE}`;
      if (!(await this.files.exists(metaPath))) continue;

      try {
        const chunks: Uint8Array[] = [];
        for await (const chunk of this.files.read(metaPath)) {
          chunks.push(chunk);
        }
        const text = new TextDecoder().decode(concatBytes(chunks));
        const config = JSON.parse(text) as LocalModelConfig;
        results.push({ modelId: config.modelId, config });
      } catch {
        // Skip unreadable metadata
      }
    }
    return results;
  }

  /**
   * Resolve the list of files to download for a model.
   * Fetches the model's file listing from HuggingFace API.
   */
  private async resolveModelFiles(
    modelId: string,
    signal?: AbortSignal,
  ): Promise<Array<{ name: string; size: number }>> {
    try {
      const url = `${HF_CDN}/api/models/${modelId}`;
      const response = await fetch(url, { signal });
      if (!response.ok) return [];
      const data = (await response.json()) as {
        siblings?: Array<{ rfilename: string; size?: number }>;
      };
      return (
        data.siblings
          ?.filter((f) => !f.rfilename.startsWith("."))
          ?.map((f) => ({ name: f.rfilename, size: f.size ?? 0 })) ?? []
      );
    } catch {
      return [];
    }
  }
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const total = chunks.reduce((a, b) => a + b.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
