import type { EngineId } from "@statewalker/ai-provider";

export type EngineAvailability = Record<EngineId, boolean>;

let cached: Promise<EngineAvailability> | undefined;

/**
 * Detect which local inference engines can run on the current host.
 *
 * - `tjs` is always available — transformers.js runs in any JS runtime via WASM.
 * - `webllm` requires WebGPU — probes `navigator.gpu.requestAdapter()` and
 *   returns `true` only if an adapter is returned.
 * - `llamacpp` requires Node.js and the native `node-llama-cpp` addon —
 *   attempts a dynamic import and returns `true` only if it succeeds.
 *
 * The probe runs once per process; the result is cached so UI consumers can
 * call this on every render without paying the detection cost repeatedly.
 */
export function detectAvailableEngines(): Promise<EngineAvailability> {
  cached ??= probe();
  return cached;
}

/** Reset the cache — intended for tests that exercise both branches. */
export function resetEngineDetectionCache(): void {
  cached = undefined;
}

async function probe(): Promise<EngineAvailability> {
  const [webllm, llamacpp] = await Promise.all([probeWebLLM(), probeLlamaCpp()]);
  return { tjs: true, webllm, llamacpp };
}

async function probeWebLLM(): Promise<boolean> {
  const nav = (globalThis as { navigator?: { gpu?: unknown } }).navigator;
  const gpu = nav?.gpu as { requestAdapter?: () => Promise<unknown> } | undefined;
  if (!gpu?.requestAdapter) return false;
  try {
    const adapter = await gpu.requestAdapter();
    return adapter != null;
  } catch {
    return false;
  }
}

async function probeLlamaCpp(): Promise<boolean> {
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
  if (!proc?.versions?.node) return false;
  try {
    // Indirect specifier so TypeScript does not try to resolve the module
    // at build time — llama.cpp is an optional runtime dependency that
    // is only installed in Node CLI contexts.
    const specifier = "node-llama-cpp";
    await import(/* @vite-ignore */ specifier);
    return true;
  } catch {
    return false;
  }
}
