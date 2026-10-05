# @statewalker/ai-local-models.browser

## What it is

The browser engine for on-device models. It registers a transformers.js factory (ONNX models through `@browser-ai/transformers-js`) on a `ModelManager` from `@statewalker/ai-agent.core/models`. Catalog entries with `runtime: "local", engine: "tjs"` can then be downloaded and activated like any other model, and previously downloaded weights are detected on the workspace `FilesApi`.

## Why it exists

Running a model in the browser needs WASM, Service Workers and multi-gigabyte weight files. None of that belongs in platform-neutral code. This package holds that browser-only glue, so `@statewalker/ai-local-models.core` and `@statewalker/ai-agent.core` stay free of ONNX runtimes, and apps that do not offer local models never load the engine SDKs.

## How to use

```sh
pnpm add @statewalker/ai-local-models.browser @browser-ai/transformers-js @huggingface/transformers
```

The engine SDKs are optional peer dependencies: `@browser-ai/transformers-js` and `@huggingface/transformers` (transformers.js) and `@mlc-ai/web-llm` (WebLLM, see Constraints). Install the ones for the engines you register.

| Import path | Exports |
| --- | --- |
| `@statewalker/ai-local-models.browser` | Nothing. The root is empty on purpose so bundlers can drop the engine SDKs. |
| `@statewalker/ai-local-models.browser/transformers` | `registerLocalProvider(manager, options?)` and the `RegisterLocalProviderOptions` type. |

`registerLocalProvider` takes a `ModelManager` and `{ basePath? }`: the folder on the manager's `FilesApi` where weight files are probed. The default is `/models/tjs`.

## Examples

### Register transformers.js on a model manager

```ts
import { ModelManager, ModelStateStore } from "@statewalker/ai-agent.core/models";
import { registerLocalProvider } from "@statewalker/ai-local-models.browser/transformers";

const store = new ModelStateStore(catalog); // catalog with engine: "tjs" entries
const manager = new ModelManager({ store, files, modelStoragePath: "/.settings/models" });

registerLocalProvider(manager, { basePath: "/.settings/models/tjs" });

for await (const progress of manager.activate("local:smollm2-360m")) {
  console.log(progress.phase, progress.message);
}
const model = store.languageModel("local:smollm2-360m");
```

## Internals

### How "downloaded" is detected

`engineHasWeights` lists `${basePath}/${modelId}` on the `FilesApi` and reports the model as present when it finds `config.json` and at least one `.onnx` (or `.onnx_data`) file. It does not rely on `LocalModelStorage` metadata, because in the browser the weight bytes are written by a Service Worker as transformers.js downloads them, not through `LocalModelStorage.download`. With no `FilesApi` configured it logs `[tjs] engineHasWeights: no FilesApi configured` and returns `false`.

### Why only WASM

The factory tries the `wasm` device only. WebGPU on the current onnxruntime-web build throws `safeint.h Integer overflow` for these models, sometimes only on the first real generation, after the factory has returned and the error can no longer be caught. If initialisation fails, the factory throws `Could not initialize <modelId> on any device — wasm: <error>`.

### Constraints

- Browser only.
- The WebLLM engine code (`src/webllm/`: catalog, language and embedding model adapters, MLC file resolver, Service Worker weight bridge) ships in the package source but is not exported, so it cannot be imported through the package `exports`.
- `basePath` must match where your Service Worker writes the weights; otherwise downloaded models show as not downloaded after a reload.

### Dependencies

- `@statewalker/ai-agent.core`: `ModelManager` and the model types the factory implements against.
- `@statewalker/webrun-files`: `FilesApi` for the weight probe.
- `@ai-sdk/provider`: language model types.
- Optional peers `@browser-ai/transformers-js`, `@huggingface/transformers`, `@mlc-ai/web-llm`: the engines.

## License

MIT
