// esbuild-wasm for the plugin builder (statewalker/statewalker-root#130): the browser build with
// its wasm module imported as a module (a Worker's way; CellB compiles `.wasm` imports the same),
// initialized once per isolate, without a worker of its own.
import type { Esbuild } from "@statewalker/webrun-bundler";
// @ts-expect-error: a CompiledWasm module, as wrangler and CellB load `.wasm` imports.
import wasmModule from "esbuild-wasm/esbuild.wasm";
import * as esbuild from "esbuild-wasm/esm/browser.js";

let ready: Promise<Esbuild> | undefined;

/** esbuild-wasm, initialized on first use. */
export function toolEsbuild(): Promise<Esbuild> {
  ready ??= (async () => {
    // esbuild's in-thread service reads the Worker's globals through `self`, which workerd
    // defines and CellB Node's realm does not.
    const g = globalThis as { self?: unknown };
    if (g.self === undefined)
      Object.defineProperty(globalThis, "self", {
        value: globalThis,
        configurable: true,
        writable: true,
      });
    await esbuild.initialize({ wasmModule: wasmModule as WebAssembly.Module, worker: false });
    return esbuild as unknown as Esbuild;
  })();
  ready.catch(() => {
    ready = undefined;
  });
  return ready;
}
