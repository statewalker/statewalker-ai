# @statewalker/ai-provider

Runtime-agnostic model manager, state store, and local-model storage for the
statewalker AI stack. Remote providers (Anthropic, OpenAI, Google,
openai-compatible) and local engines (transformers.js, WebLLM, llama.cpp) are
registered against a single `ModelManager` and drive one `ModelStateStore` that
the UI reads from.

## Multi-engine registry

`LocalModelConfig.engine` is a required discriminator — one of
`"tjs" | "webllm" | "llamacpp"` — and each engine registers its own factory:

```ts
import { ModelManager, ModelStateStore, createDefaultCatalog } from "@statewalker/ai-provider";
import { registerLocalProvider } from "@statewalker/ai-provider-local"; // tjs
import { registerWebLLMProvider } from "@statewalker/ai-provider-webllm";
import { registerLlamaCppProvider } from "@statewalker/ai-provider-llamacpp";

const store = new ModelStateStore(createDefaultCatalog());
const manager = new ModelManager({ store, files });

registerLocalProvider(manager);                      // engine: "tjs"
registerWebLLMProvider(manager);                     // engine: "webllm"
registerLlamaCppProvider(manager, { rootDir });      // engine: "llamacpp"
```

`manager.activate(key)` dispatches to the factory registered for
`config.engine`; missing factories yield an `error` phase and set
`ModelStatus === "error"` so the UI can surface a Retry affordance.

Check availability without activating: `manager.hasFactory("webllm")`.

## Engine-namespaced storage

`LocalModelStorage` writes weights at `{basePath}/{engine}/{modelId}/` when the
`engine` constructor option is supplied. This lets multiple engines coexist —
e.g. transformers.js ONNX shards under `/models/tjs/qwen2-1.5b/` do not
collide with GGUF files under `/models/llamacpp/llama-3.2-3b/`.

## Resolver hooks

Each engine registers a `fileResolver` and optional `verifier` so
`LocalModelStorage` can handle engine-specific layouts without hard-coding
them:

- **tjs** — default ONNX layout (resolver reads the HuggingFace tree).
- **webllm** — resolves `mlc-chat-config.json` + `ndarray-cache.json` + all
  `params_shard_*.bin` + tokenizer + the `.wasm` library from
  `config.mlcModelLib`.
- **llamacpp** — single-file resolver: `[{ name: config.ggufFile, size }]`.

## Dispose lifecycle

`ModelManager.deactivate(key)` calls `[Symbol.asyncDispose]` /
`[Symbol.dispose]` on the stored `LanguageModelV3` instance if present, so
engines like llama.cpp can free their native `LlamaContext`/`LlamaModel`
handles.

## Persistence migration

Workspaces that predate the engine discriminator stored weights at
`/models/{modelId}/`. `@repo/ai-provider-core`'s startup controller runs
`migrateEngineNamespacing()` once per workspace, moving legacy directories
into `/models/tjs/{modelId}/` and writing a marker to
`/.settings/migrations.json`. Download metadata in `/.settings/models/` also
grew an optional `engine` field; legacy entries without it are treated as
`"tjs"`.
