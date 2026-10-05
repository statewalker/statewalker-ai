# @statewalker/ai-config.core

## What it is

A workspace fragment that holds the AI configuration: provider **connections**, their **discovered models**, and the **active selection**. One adapter, `AiConfig`, is the source of truth for chat and for other consumers such as a wiki. It stores no credentials: API keys live in the workspace `Secrets` adapter. It also ships the React-free contract (json-render spec, catalog id, component and action names) for the "Remote Models" settings panel, which `@statewalker/ai-config.view.react` renders.

## Why it exists

Several features need the same answers: which providers the user connected, which models each one offers, and which model is selected. Keeping that in one adapter gives one place to add a connection and one active selection. Keeping keys out of the config document means the document can be saved, synced or shown without leaking secrets. Providers are built directly with `@ai-sdk/openai`, `@ai-sdk/anthropic` and `@ai-sdk/google`, so this package does not depend on the agent packages.

## How to use

```sh
pnpm add @statewalker/ai-config.core
```

No peer dependencies. The workspace (`@statewalker/workspace.core`) must have the `Secrets` and `Commands` adapters.

| Import path | Contents |
| --- | --- |
| `@statewalker/ai-config.core` | `AiConfig` (abstract adapter class), `AiConfigImpl`, `apiKeySecretKey`, the `ai-config:*` commands, `seedAiConfigFromEnv`, `createLiveProviderRegistry`, model-reference helpers, capability and default-starred helpers, the connections panel contract, constants and types. The fragment `init` is also the default export. |
| `@statewalker/ai-config.core/fragment` | Default export: the fragment `init(ctx)` function. |

Register the fragment. It sets the `AiConfig` adapter, loads the config when the workspace opens, and handles the `ai-config:*` commands.

```ts
import initAiConfig from "@statewalker/ai-config.core/fragment";

const cleanup = initAiConfig(ctx);
```

`AiConfig` is an abstract class, so it is both the adapter key and the contract:

- Reads (synchronous): `listConnections()`, `getConnection(id)`, `getModels(connectionId, capability?)`, `getActive()`.
- Async reads: `getProvider(connectionId)`, `hasKey(connectionId)`, `getApiKey(connectionId)`.
- Writes (async; they touch `Secrets` and persist the document): `upsertConnection(connection, apiKey?)`, `removeConnection(id)`, `disconnect(connectionId)`, `setApiKey(connectionId, apiKey)`, `refreshModels(connectionId)`, `setActive(connectionId, modelId)`, `starModels(connectionId, modelIds)`.
- `onUpdate(cb)`: subscribe to changes.

Connection types: `openai`, `anthropic`, `google`, `openai-compatible`. Capabilities: `chat`, `embedding`, `image-gen`, `tts`.

## Examples

### Add a connection and discover its models

```ts
import { AiConfig } from "@statewalker/ai-config.core";

const config = workspace.requireAdapter(AiConfig);

await config.upsertConnection(
  { id: "openai-work", type: "openai", name: "OpenAI (work)", starredModelIds: [] },
  process.env.OPENAI_API_KEY, // stored in Secrets, not in the config file
);

const models = await config.refreshModels("openai-work"); // GET …/models
await config.setActive("openai-work", models[0].id);
```

### Build a provider for the active selection

```ts
const active = config.getActive(); // { connectionId?, modelId? }
if (active.connectionId && active.modelId) {
  const provider = await config.getProvider(active.connectionId); // ProviderV4
  const model = provider.languageModel(active.modelId);
}
```

### Resolve models by reference

A model reference is `connectionId:modelId` (split on the first colon). `createLiveProviderRegistry` resolves references and rebuilds itself on every `AiConfig` update:

```ts
import { createLiveProviderRegistry, formatModelReference } from "@statewalker/ai-config.core";

const registry = await createLiveProviderRegistry(config);
const model = registry.languageModel(formatModelReference("openai-work", "gpt-4o"));
const embedder = registry.textEmbeddingModel("openai-work:text-embedding-3-small");
registry.dispose();
```

### Filter models by capability

```ts
import { capabilitiesFor } from "@statewalker/ai-config.core";

const chatModels = config.getModels("openai-work", "chat");
const embeddingModels = config.getModels("openai-work", "embedding");

capabilitiesFor("text-embedding-3-small"); // ["embedding"]; unknown ids → ["chat"]
```

### Seed connections from environment variables (Node host)

```ts
import { seedAiConfigFromEnv } from "@statewalker/ai-config.core";

// Reads OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY.
// A key already stored in Secrets always wins.
await seedAiConfigFromEnv(workspace, process.env);
```

### Use commands

```ts
import { UpsertConnectionCommand } from "@statewalker/ai-config.core";
import { Commands } from "@statewalker/shared-commands";

const commands = workspace.requireAdapter(Commands);
await commands.call(UpsertConnectionCommand, {
  connection: { id: "anthropic", type: "anthropic", name: "Anthropic", starredModelIds: [] },
  apiKey: "sk-ant-…",
}).promise;
```

The fragment handles `UpsertConnectionCommand`, `RemoveConnectionCommand`, `SetApiKeyCommand`, `RefreshModelsCommand`, `SetActiveModelCommand` and `StarModelsCommand`. `ConfigureAiCommand` (open the settings dialog on the connections tab) is handled by the renderer.

## Internals

### Where things are stored and how they change

- **Storage.** The document is `/.settings/ai-config.json` (schema version 6, `AI_CONFIG_SCHEMA_VERSION`). Keys are stored in `Secrets` under `ai.connection.<id>.apiKey` (`apiKeySecretKey(id)`).
- **Plaintext keys are lifted out on load.** If a connection in the document carries an `apiKey` field, `load()` writes it to `Secrets`, removes it, and saves the document again, so this happens at most once.
- **Disconnect vs remove.** `disconnect()` deletes the key and the discovered and starred models but keeps the connection's id, type, name, url and headers. `removeConnection()` deletes everything, including the key.
- **Discovery.** `refreshModels` calls the provider's model list endpoint with the provider's auth scheme and any per-connection headers. Google results are limited to models that support `generateContent`. Non-2xx responses become errors (body truncated to 512 characters). `openai-compatible` connections need a `url` (otherwise: `openai-compatible Connection requires a url`); `anthropic` needs one in the browser because of CORS.
- **Capabilities** come from a curated id-pattern table, because model list endpoints do not report them reliably.
- **Default stars.** On the first successful connect (empty `starredModelIds`), `applyDefaultStarred` stars models that match a curated per-type pattern list. Later refreshes never re-apply it.
- Local model entries can be recorded in the document, but this package does not load local models.

### Dependencies

- `@statewalker/workspace.core`: workspace, `Secrets`, adapters, lifecycle hooks.
- `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/provider`, `ai`: building providers and the provider registry.
- `@statewalker/webrun-files`: reading and writing the JSON document.
- `@statewalker/shared-commands`, `@statewalker/shared-registry`: the `ai-config:*` commands and cleanup.
- `@json-render/core`: `Spec` type of the connections panel contract.

## License

MIT
