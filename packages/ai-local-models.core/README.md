# @statewalker/ai-local-models.core

## What it is

A workspace fragment for local (in-browser) models. It provides the `LocalModels` adapter, which wraps a `ModelManager` with the transformers.js engine and a curated catalog, tracks downloads and the active local model in its own `local-models.json`, and turns a selected local model into an `ActiveModel` value of `kind: "local"` for `@statewalker/ai-agent-runtime.core`. It also contributes the "Local Models" settings tab and ships its json-render spec. It contains no React code.

## Why it exists

Local models have a lifecycle that remote providers do not: weights must be downloaded, survive reloads, and be loaded into memory before the first call. This fragment owns that lifecycle and its persistence, so the agent runtime only sees one more `ModelProvider` and the UI only talks to one adapter and one command.

## How to use

```sh
pnpm add @statewalker/ai-local-models.core
```

No peer dependencies. Register it after `@statewalker/ai-agent-runtime.core` (it needs `ActiveModel`) on a workspace that has the `Commands` and `Slots` adapters.

| Import path | Exports |
| --- | --- |
| `@statewalker/ai-local-models.core` | `LocalModels`, `SelectLocalModelCommand`, `localCatalog`, `localCatalogEntries`, `emptyLocalModelsConfig`, `makeLocalModelsTabSpec`, `makeLocalModelsTabInitialState`, constants (`AI_LOCAL_MODELS_CATALOG_ID`, `LOCAL_MODELS_TAB_ID`, `LOCAL_MODELS_TAB_VIEW_KEY`, `TJS_WEIGHTS_BASE_PATH`), types (`LocalModelEntry`, `LocalModelsConfig`, `LocalModelDownload`, `LocalModelsOptions`, `SelectLocalModelPayload`). The fragment `init` is also the default export. |
| `@statewalker/ai-local-models.core/fragment` | Default export: `init(ctx)`. |

`init(ctx)` registers `LocalModels` as a lazy adapter, provides the settings tab (`settingsTabSlot` from `@statewalker/settings.core`), handles `SelectLocalModelCommand`, and on workspace load restores the saved active local model.

The catalog keys are `local:smollm2-135m`, `local:smollm2-360m`, `local:smollm2-1.7b` and `local:qwen3.5-0.8b`.

## Examples

### Start the fragment

```ts
import initAgentRuntime from "@statewalker/ai-agent-runtime.core/fragment";
import initAiLocalModels from "@statewalker/ai-local-models.core/fragment";

initAgentRuntime(ctx);
const cleanup = initAiLocalModels(ctx);
```

### Download a model

```ts
import { LocalModels, localCatalog } from "@statewalker/ai-local-models.core";

const localModels = workspace.requireAdapter(LocalModels);

// Status is looked up by catalog key; list() returns the entries without keys.
for (const [key, entry] of Object.entries(localCatalog)) {
  console.log(key, entry.label, entry.size, localModels.status(key));
}

for await (const progress of localModels.download("local:smollm2-360m")) {
  console.log(progress.phase, progress.message);
}
await localModels.markDownloaded("local:smollm2-360m");
```

`download` does not record the download itself; call `markDownloaded` when it completes. `cancelDownload(key)` aborts it, and `removeWeights(key)` deletes the weights and the record.

### Select a local model for the agent

```ts
import { SelectLocalModelCommand } from "@statewalker/ai-local-models.core";
import { Commands } from "@statewalker/shared-commands";

const commands = workspace.requireAdapter(Commands);
await commands.call(SelectLocalModelCommand, { modelId: "local:smollm2-360m" }).promise;

// Clear the local selection:
await commands.call(SelectLocalModelCommand, { modelId: undefined }).promise;
```

Selecting writes `ActiveModel` (`kind: "local"`, `providerId: "local"`, `modelId` = the catalog key), saves the key as active, and starts loading the model into memory in the background.

## Internals

### Activation does not block selection

```
SelectLocalModelCommand ──► ActiveModel.set({ kind: "local", … })  ──► agent runtime rebuilds
                        └─► LocalModels.setActiveKey(key)           ──► local-models.json
                        └─► manager.activate(key)  (background)     ──► weights loaded into memory
```

The command resolves before the model is loaded. An activation failure is logged as `[ai-local-models] local activation failed for <key>:` and shows up as the model's status in `ModelStateStore`, and on the agent's next model call.

### Persistence

The config is `/.settings/local-models.json`: `{ schemaVersion: 1, downloaded: [{ key, downloadedAt }], active? }`. If the file is missing, `load()` builds it from the `local` section of `/.settings/providers.json` when that file exists, then writes `local-models.json`; after that `providers.json` is not read again. Write errors are ignored (persistence is best-effort). A `local-models.json` that is not valid JSON is treated as empty, so downloads and the active model are forgotten without an error.

### Why the adapter is lazy

`workspace.files` throws while no file system is installed. `LocalModels` is registered as a factory and constructed only when first requested, which happens on workspace load.

### Constraints

- Only the transformers.js (`tjs`) engine is registered, and it runs on WASM only.
- Browser only in practice: activation goes through `@statewalker/ai-local-models.browser`.
- `LocalModels` looks for downloaded weights under `<basePath>/tjs/<modelId>` (`TJS_WEIGHTS_BASE_PATH` with the default `basePath`, `/.settings/models`): a `config.json` and at least one `.onnx` file there make the model show as downloaded after a reload. Weights written anywhere else are not found.
- `buildProvider(key)` returns the same `ModelStateStore` for every key; the store resolves the model by the key passed to `languageModel`.

### Dependencies

- `@statewalker/ai-agent.core`: `ModelManager`, `ModelStateStore`, model types.
- `@statewalker/ai-local-models.browser`: the transformers.js factory.
- `@statewalker/ai-agent-runtime.core`: `ActiveModel`.
- `@statewalker/settings.core`: `settingsTabSlot`.
- `@statewalker/workspace.core`, `@statewalker/shared-commands`, `@statewalker/shared-slots`, `@statewalker/shared-registry`, `@statewalker/shared-baseclass`: workspace adapters, commands, slots, cleanup, observable adapter.
- `@statewalker/webrun-files`: reading and writing `local-models.json`.
- `@json-render/core`: `Spec` type of the settings tab.

## License

MIT
