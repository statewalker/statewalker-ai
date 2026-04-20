/**
 * Helpers for talking to the WebLLM weight-bridge Service Worker.
 *
 * The page registers URL→FilesApi-path mappings after each model download;
 * the SW then intercepts WebLLM's HuggingFace fetches and serves weight
 * shards from the FilesApi. This keeps WebLLM on its default `"cache"`
 * backend (no fork of tvmjs) while letting our OPFS-backed FilesApi own
 * the bytes on disk.
 */

export interface WeightBridgeMessage {
  type: "register-mapping" | "unregister-mapping" | "set-files-handle";
  urlPattern?: string;
  basePath?: string;
  handle?: FileSystemDirectoryHandle;
}

function controller(): ServiceWorker | null {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator))
    return null;
  return navigator.serviceWorker.controller;
}

/**
 * Register a URL→FilesApi-path mapping with the active Service Worker.
 * No-ops (with a console warning) if no SW is controlling the page — the
 * caller is expected to have awaited `navigator.serviceWorker.ready`.
 */
export async function registerWebLLMUrlMapping(
  urlPattern: string,
  basePath: string,
): Promise<void> {
  const sw = controller();
  if (!sw) {
    console.warn(
      "[ai-provider-webllm] No active Service Worker; WebLLM weight bridge inactive. " +
        "Register the SW before activating WebLLM models.",
    );
    return;
  }
  sw.postMessage({
    type: "register-mapping",
    urlPattern,
    basePath,
  } satisfies WeightBridgeMessage);
}

/** Remove a previously-registered mapping (e.g. on model deletion). */
export async function unregisterWebLLMUrlMapping(
  urlPattern: string,
): Promise<void> {
  const sw = controller();
  if (!sw) return;
  sw.postMessage({
    type: "unregister-mapping",
    urlPattern,
  } satisfies WeightBridgeMessage);
}

/**
 * Hand an OPFS directory handle to the SW so it can read weight files
 * directly. Call once during bootstrap, after the user has granted
 * directory access.
 */
export async function propagateFilesHandle(
  handle: FileSystemDirectoryHandle,
): Promise<void> {
  const sw = controller();
  if (!sw) return;
  sw.postMessage({
    type: "set-files-handle",
    handle,
  } satisfies WeightBridgeMessage);
}
