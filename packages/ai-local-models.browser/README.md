# @statewalker/ai-local-models.browser

## What it is

The browser-platform implementation of in-browser, on-device model
engines. It registers two local-model factories on an
`@statewalker/ai-agent` `ModelManager` — **transformers.js** (ONNX models
via `@browser-ai/transformers-js`) and **WebLLM** (MLC/WebGPU models via
`@mlc-ai/web-llm`) — plus the supporting pieces those engines need:
weight-presence probes over a workspace `FilesApi`, a WebLLM model
catalog, a Service-Worker weight bridge that tees downloaded shards onto
disk, an MLC file resolver/verifier, and a `LanguageModelV3`/
`EmbeddingModelV3` adapter around an `MLCEngine`.

## Why it exists

`@statewalker/ai-providers` resolves *remote* providers; running a model
locally in the browser is a different, platform-specific problem (WebGPU,
WASM, Service Workers, OPFS, multi-gigabyte weight files). This is the
`.browser` aspect package per the platform split: the engine glue that
only makes sense in a browser stays out of the React-free logic fragment
and the Node side. It exists so a workbench app can offer downloadable,
fully-offline models without the logic layer knowing anything about ONNX
runtimes or MLC shard layouts.

## How to use

```sh
pnpm add @statewalker/ai-local-models.browser
```

The engine SDKs are **optional peer dependencies** —
`@browser-ai/transformers-js`, `@huggingface/transformers`, and
`@mlc-ai/web-llm`. Install only the ones whose engine you actually
register; they're loaded lazily at activation time, never at import time.

> **Note:** the package root (`./`) is intentionally empty right now —
> every browser-engine export is commented out at `src/index.ts` so apps
> that never import a sub-path tree-shake the heavy engine SDKs out of
> their bundle. Reach the live functionality through the source modules
> (`./src/register.js`, `./src/webllm/register.js`, etc.) or the
> `./transformers` sub-path.

```ts
import type { ModelManager } from "@statewalker/ai-agent/models";
import { registerBrowserProviders } from "@statewalker/ai-local-models.browser/src/register.js";

registerBrowserProviders(manager); // currently wires transformers.js only
```

## Examples

### Register the transformers.js engine

```ts
import { registerLocalProvider } from "@statewalker/ai-local-models.browser/transformers";

registerLocalProvider(manager, {
  // weights live alongside other workspace artifacts
  basePath: "/.settings/models/tjs",
});
// Activates `runtime: "local", engine: "tjs"` catalog entries through
// @browser-ai/transformers-js. Defaults to WASM (WebGPU is intentionally
// skipped — see Constraints).
```

### Register the WebLLM engine and its catalog

```ts
import { createDefaultCatalog, mergeCatalogs } from "@statewalker/ai-agent/models";
import { registerWebLLMProvider } from "@statewalker/ai-local-models.browser/src/webllm/register.js";
import { webllmCatalog } from "@statewalker/ai-local-models.browser/src/webllm/catalog.js";

const catalog = mergeCatalogs(createDefaultCatalog(), webllmCatalog);
registerWebLLMProvider(manager, { basePath: "/.settings/models/webllm" });
```

### Wire the Service-Worker weight bridge

The bridge lets WebLLM keep its default `"cache"` backend while your
OPFS-backed `FilesApi` owns the bytes on disk:

```ts
import {
  propagateFilesHandle,
  registerWebLLMUrlMapping,
  unregisterWebLLMUrlMapping,
} from "@statewalker/ai-local-models.browser/src/webllm/sw-bridge.js";

await navigator.serviceWorker.ready;
await propagateFilesHandle(opfsDirectoryHandle); // once, at bootstrap
// registerWebLLMProvider registers the per-model URL mapping internally
// before each engine.reload; unregister on model deletion:
await unregisterWebLLMUrlMapping(urlPattern);
```

### Use the WebLLM model adapters directly

```ts
import { WebLLMLanguageModel } from "@statewalker/ai-local-models.browser/src/webllm/language-model.js";
import { WebLLMEmbeddingModel } from "@statewalker/ai-local-models.browser/src/webllm/embedding-model.js";

const lm = new WebLLMLanguageModel(engine, modelId);    // LanguageModelV3
const emb = new WebLLMEmbeddingModel(engine, modelId);  // EmbeddingModelV3
```

## Internals

```
ModelManager.registerLocalFactory(engine, {
  engineHasWeights,   // probe FilesApi after reload
  factory,            // build a LanguageModelV3 (downloads on first call)
  fileResolver?,      // WebLLM: list shards/config/tokenizer + sizes
  verifier?,          // WebLLM: confirm required files present
})
```

### Architectural decisions

- **FilesApi is the source of truth for "downloaded".** Both engines'
  `engineHasWeights` probes the on-disk directory rather than the SDK's
  own cache check. For transformers.js the bytes flow through the SW
  write-through, never via `LocalModelStorage.download`, so there's no
  metadata file to trust; WebLLM's `hasModelInCache` throws on
  custom-catalog entries absent from its prebuilt list. The presence of
  the config file plus weight shards is the right signal in both cases.

- **SW weight bridge over a tvmjs fork.** WebLLM downloads weights via
  HuggingFace fetches; the Service Worker intercepts those and tees the
  bytes to FilesApi as they stream past, registered *before*
  `engine.reload`. This keeps WebLLM on its stock `"cache"` backend.

- **Cache-API fallback sync.** The SW only catches *network* fetches, so
  a model already in WebLLM's Cache API (prior session, another app on
  the same origin) reloads without touching the SW — leaving the
  workspace folder empty. `syncWeightsFromCache` copies those artifacts
  into FilesApi after reload, best-effort.

- **Lazy SDK loading.** `getWebLLMModule()` dynamically imports
  `@mlc-ai/web-llm` at activation, so `registerWebLLMProvider` is safe to
  call in any environment (including SSR / Node).

### Algorithms

- **MLC file resolution.** `resolveMlcFiles` fetches `mlc-chat-config.json`
  and `ndarray-cache.json`, then enumerates tensor shards (sizes from
  `ndarray-cache` `nbytes`), tokenizer files, and the wasm library
  (sizes via HEAD; zero is acceptable — `LocalModelStorage` falls back to
  `config.sizeBytes`). `verifyMlcWeights` confirms
  `mlc-chat-config.json`, `ndarray-cache.json`, and at least one
  `params_shard_*.bin`.

- **Device selection (transformers.js).** The factory tries `["wasm"]`
  only. WebGPU on the current onnxruntime-web build reliably throws
  `safeint.h Integer overflow` for these models — sometimes only on the
  first real generation, past the factory boundary where it can't be
  caught — so WebGPU is never selected.

- **Embedding guard.** `registerWebLLMProvider`'s factory must return a
  `LanguageModelV3`. Embedding models (detected by `"embed"` in the
  family or modelId) throw loudly, directing callers to instantiate
  `WebLLMEmbeddingModel` from their own `MLCEngine` instead.

### Constraints

- **Browser only** — depends on Service Workers, OPFS / `FileSystemDirectoryHandle`,
  WebGPU/WASM, and `fetch` interception. Not usable in Node.
- **WebLLM catalog is function-calling models only.** Only the Hermes
  models survive an `engine.chat.completions.create({ tools })` call,
  which the agent issues on every tool-using turn; other models throw
  `UnsupportedModelIdError`. The list mirrors WebLLM v0.2.82's
  `functionCallingModelIds`.
- **WebLLM is currently disabled in `registerBrowserProviders`** — only
  transformers.js is wired; re-enable the commented call when needed.
- **Without an active Service Worker** the WebLLM weight bridge no-ops
  (with a warning); register the SW and await
  `navigator.serviceWorker.ready` before activating WebLLM models.
- **Mistral 7B (q4f16)** requires the `shader-f16` GPU feature; there's no
  `requiredFeatures` field on `LocalModelConfig` yet, so it isn't filtered
  at the catalog level — WebLLM surfaces a runtime error if unsupported.

### Dependencies

- `@statewalker/ai-agent` (`/models`) — `ModelManager`,
  `LocalModelConfig`, `ActivationProgress`, catalog helpers; this package
  is purely glue that registers factories onto it.
- `@statewalker/webrun-files` — the `FilesApi` weights are persisted to
  and probed against.
- `@ai-sdk/provider` — `LanguageModelV3` / `EmbeddingModelV3` /
  `LanguageModelV3Prompt` the adapters implement.
- **Optional peers:** `@browser-ai/transformers-js`,
  `@huggingface/transformers`, `@mlc-ai/web-llm` — the actual engines,
  loaded lazily; install only what you register.

## Related

- `@statewalker/ai-providers` — the
  React-free logic fragment for remote providers and the active-model
  pointer; this package is its browser-platform local-engine companion.
- `@statewalker/ai-agent` — the `ModelManager`,
  catalog, and local-model storage these factories register against.

## License

MIT — see the monorepo root `LICENSE`.
