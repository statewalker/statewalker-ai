// biome-ignore lint/suspicious/noExplicitAny: node-llama-cpp types are loaded dynamically
type LlamaCppModule = any;

let _module: LlamaCppModule | null = null;

/**
 * Lazy-load `node-llama-cpp`. Throws a clear error at activation time if
 * the addon is missing or fails to load on the current platform — never
 * at module-import time, so the package is safe to import in browser
 * bundles.
 */
export async function getLlamaCppModule(): Promise<LlamaCppModule> {
  if (_module) return _module;
  try {
    _module = await import("node-llama-cpp");
  } catch (e) {
    throw new Error(
      "node-llama-cpp not installed or unsupported on this platform. " +
        "Install it with: pnpm add node-llama-cpp",
      { cause: e instanceof Error ? e : undefined },
    );
  }
  return _module;
}

export type { LlamaCppModule };
