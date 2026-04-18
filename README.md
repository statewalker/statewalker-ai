# @statewalker/ai-provider-llamacpp

Node-only local inference via [`node-llama-cpp`](https://github.com/withcatai/node-llama-cpp) and GGUF weights, wired
into the `ModelManager` registry as engine `"llamacpp"`.

## Install

`node-llama-cpp` is declared as an **optional dependency** (it ships a
native addon with prebuilt binaries that are not available in every
environment). Add it to the host app if you want the llama.cpp path:

```
pnpm add @statewalker/ai-provider-llamacpp node-llama-cpp
```

The package lazy-imports the addon. Browsers and Node installations
without prebuilt binaries keep working — the factory throws a clear
error only when activation is attempted.

## Usage

```ts
import { registerLlamaCppProvider, llamaCppCatalog } from "@statewalker/ai-provider-llamacpp";
import { ModelManager, ModelStateStore, createDefaultCatalog, mergeCatalogs } from "@statewalker/ai-provider";
import { NodeFilesApi } from "@statewalker/webrun-files-node";

const rootDir = process.env.HOME + "/.statewalker";
const files = new NodeFilesApi(rootDir);
const store = new ModelStateStore(
  mergeCatalogs(createDefaultCatalog(), llamaCppCatalog),
);
const manager = new ModelManager({ store, files });
registerLlamaCppProvider(manager, { rootDir });

for await (const p of manager.activate("llamacpp-llama-3.2-3b-q4")) {
  process.stderr.write(`${p.phase} ${p.message}\n`);
}
const model = store.getLanguageModel("llamacpp-llama-3.2-3b-q4");
```

## Requirements

- **Node.js with the `node-llama-cpp` addon.** The package uses memory-mapped
  GGUF files, so the `FilesApi` passed to the `ModelManager` must be
  disk-backed — hence the required `rootDir` option on `registerLlamaCppProvider`.
- **GGUF catalog entries** declare `ggufFile` (the single weight file inside
  the HuggingFace repo). See `llamaCppCatalog` for Llama 3.2, Qwen 2.5, and
  Phi 3.5 presets.

## Disposal

`LlamaCppLanguageModel` implements `[Symbol.asyncDispose]`, which
`ModelManager.deactivate(key)` invokes to release the underlying
`LlamaContext` and `LlamaModel` handles. Call `manager.deactivate` rather
than dropping references to free GPU/RAM pressure.
