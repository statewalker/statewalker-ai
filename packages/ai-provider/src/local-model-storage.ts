import type { FileInfo, FilesApi } from "@statewalker/webrun-files";
import type {
  ActivationProgress,
  EngineId,
  LocalModelConfig,
} from "./types.js";

const METADATA_FILE = "model.json";
const HF_CDN = "https://huggingface.co";

/** Produces the file list to download for a model. */
export type FileResolver = (
  modelId: string,
  config: LocalModelConfig,
  signal?: AbortSignal,
) => Promise<Array<{ name: string; size: number }>>;

/** Predicate that decides whether a model directory contains valid weights. */
export type WeightVerifier = (
  entries: AsyncIterable<FileInfo>,
) => Promise<boolean>;

export interface LocalModelStorageOptions {
  /** Root path for all model storage, default `/models`. */
  basePath?: string;
  /**
   * Engine identifier; when provided, paths are namespaced as
   * `/{basePath}/{engine}/{modelId}/` so multiple engines can coexist.
   */
  engine?: EngineId;
}

export interface DownloadOptions {
  /** Custom resolver for the file list (e.g. MLC shards, single GGUF). */
  fileResolver?: FileResolver;
  signal?: AbortSignal;
}

/**
 * Manages local model files (weights, config, tokenizer) via FilesApi.
 * Handles downloading from HuggingFace CDN with progress and resume support.
 */
export class LocalModelStorage {
  readonly files: FilesApi;
  private readonly basePath: string;
  private readonly engine: EngineId | undefined;

  constructor(
    files: FilesApi,
    optionsOrBasePath: LocalModelStorageOptions | string = {},
  ) {
    this.files = files;
    if (typeof optionsOrBasePath === "string") {
      this.basePath = optionsOrBasePath;
      this.engine = undefined;
    } else {
      this.basePath = optionsOrBasePath.basePath ?? "/models";
      this.engine = optionsOrBasePath.engine;
    }
  }

  private modelDir(modelId: string): string {
    return this.engine
      ? `${this.basePath}/${this.engine}/${modelId}`
      : `${this.basePath}/${modelId}`;
  }

  /** Default verifier: metadata file + at least one ONNX weight file. */
  private static defaultVerifier: WeightVerifier = async (entries) => {
    for await (const entry of entries) {
      if (
        entry.kind === "file" &&
        (entry.name.endsWith(".onnx") || entry.name.includes(".onnx_data"))
      ) {
        return true;
      }
    }
    return false;
  };

  /** Check if model weights exist in storage. */
  async hasWeights(modelId: string, verify?: WeightVerifier): Promise<boolean> {
    const dir = this.modelDir(modelId);
    const meta = await this.files.stats(`${dir}/${METADATA_FILE}`);
    if (!meta) return false;
    const verifier = verify ?? LocalModelStorage.defaultVerifier;
    return verifier(this.files.list(dir));
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
    options?: DownloadOptions | AbortSignal,
  ): AsyncGenerator<ActivationProgress> {
    const opts: DownloadOptions =
      options instanceof AbortSignal ? { signal: options } : (options ?? {});
    const signal = opts.signal;
    const resolver = opts.fileResolver;
    const dir = this.modelDir(modelId);
    await this.files.mkdir(dir);

    // Resolve files to download — use custom resolver if provided
    const filesToDownload = resolver
      ? await resolver(modelId, config, signal)
      : await this.resolveModelFiles(modelId, signal);

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
