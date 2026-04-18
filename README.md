# @statewalker/ai-provider-webllm

Browser-only WebGPU inference via [`@mlc-ai/web-llm`](https://github.com/mlc-ai/web-llm), wired into the `ModelManager`
registry as engine `"webllm"`.

## Install

`@mlc-ai/web-llm` is declared as an **optional dependency**. Add it to the
host app only if you want the WebLLM path:

```
pnpm add @statewalker/ai-provider-webllm @mlc-ai/web-llm
```

The package lazy-imports the SDK, so bundling environments that strip it
(Node CLI, non-WebGPU browsers) keep working — the factory just throws a
clear error if the dependency is missing when activation is attempted.

## Usage

```ts
import { registerWebLLMProvider, webllmCatalog } from "@statewalker/ai-provider-webllm";
import { ModelManager, ModelStateStore, createDefaultCatalog, mergeCatalogs } from "@statewalker/ai-provider";

const store = new ModelStateStore(
  mergeCatalogs(createDefaultCatalog(), webllmCatalog),
);
const manager = new ModelManager({ store, files });
registerWebLLMProvider(manager);

for await (const p of manager.activate("webllm-llama-3.2-1b")) {
  console.log(p.phase, p.progress, p.message);
}
```

## Requirements

- **WebGPU** — `navigator.gpu.requestAdapter()` must return an adapter.
  Use `detectAvailableEngines()` from `@repo/ai-provider-core` to probe
  before rendering WebLLM-only catalog entries.
- **Service Worker weight bridge** (optional but recommended). Without it,
  WebLLM fetches weights directly from the HuggingFace CDN on every cold
  start. See [`chat.app/src/webllm-weight-bridge.sw.ts`](../../../workspace-explorer/apps/chat.app/src/webllm-weight-bridge.sw.ts)
  for a reference implementation that serves MLC shards from a FilesApi
  (OPFS) store.
