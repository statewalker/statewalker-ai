# @statewalker/ai-config

## What it is

The unified AI-configuration logic fragment: one workspace adapter (`AiConfig`) that is the single source of truth for provider **connections**, their **discovered models**, and the **active selection**. It is credential-free — API keys live in the workspace `Secrets` adapter, never in the config document — and builds `@ai-sdk/*` providers on demand straight from a connection's stored key. Both chat (`ActiveModel`) and wiki (`WikiLlmConfiguration`) bind to it by id reference. The package also ships the React-free contract for the "Remote Models" settings panel (the json-render spec, catalog id, component/action vocabularies) that its paired renderer implements.

## Why it exists

It consolidates what used to be split across `ai-providers` v5 and `models-config`: provider connection definitions, model discovery caches, the active-model pointer, and a tangle of where credentials lived. The design rules that fell out of that consolidation:

- **Credentials never touch the config file.** A `Connection` has no `apiKey` field; keys are keyed `ai.connection.<id>.apiKey` in `Secrets` and read only at `getProvider`/`refreshModels` time. The store even migrates legacy plaintext keys (from pre-v6 `providers.json`) into `Secrets` on load and strips them.
- **Providers are built directly from `@ai-sdk/*`**, not via `@statewalker/ai-agent`. Routing provider construction through an `@statewalker/ai-*` package would form a workbench ↔ ai dependency cycle; `provider-build.ts` inlines `createOpenAI`/`createAnthropic`/`createGoogleGenerativeAI` to keep this package cycle-free.
- **One adapter, shared by chat and wiki**, so there is a single place to add a connection and a single active-selection pointer.

Per ADR 0002 it is logic-only (no React); the renderer is `@statewalker/ai-config.view.react`.

## How to use

```sh
pnpm add @statewalker/ai-config
```

The default export is the fragment `init(ctx)`. It registers the `AiConfig` adapter, loads the config on workspace open, and wires the `ai-config:*` command handlers.

```ts
import initAiConfig from "@statewalker/ai-config/fragment";
const cleanup = initAiConfig(ctx);
```

Then resolve the adapter and use its read/write surface:

```ts
import { AiConfig } from "@statewalker/ai-config";
const config = workspace.requireAdapter(AiConfig);
```

`AiConfig` is an abstract class (the concrete `AiConfigImpl` is registered by the fragment). Reads are synchronous (`listConnections`, `getConnection`, `getModels`, `getActive`); writes are async because they round-trip `Secrets` and persist the JSON document.

## Examples

### Add a connection and discover its models

```ts
import { AiConfig } from "@statewalker/ai-config";

const config = workspace.requireAdapter(AiConfig);

await config.upsertConnection(
  { id: "openai-work", type: "openai", name: "OpenAI (work)", starredModelIds: [] },
  process.env.OPENAI_API_KEY, // stored in Secrets, not the config file
);

const models = await config.refreshModels("openai-work"); // hits /v1/models
await config.setActive("openai-work", models[0].id);
```

### Build a provider for the active selection

```ts
const active = config.getActive(); // { connectionId, modelId }
if (active.connectionId) {
  const provider = await config.getProvider(active.connectionId); // ProviderV3
  // key is read from Secrets here, never from the Connection
}
```

### Filter discovered models by capability

```ts
import { capabilitiesFor } from "@statewalker/ai-config";

const chatModels = config.getModels("openai-work", "chat");
const embeddings = config.getModels("openai-work", "embedding");

// Tag an arbitrary id (curated table; unknown ids default to ["chat"]):
capabilitiesFor("text-embedding-3-small"); // → ["embedding"]
```

### Seed connections from environment variables (Node host)

```ts
import { seedAiConfigFromEnv } from "@statewalker/ai-config";

// For each known provider env var, register a connection + key ONLY when
// Secrets has no key for it. A stored secret always wins.
await seedAiConfigFromEnv(workspace, process.env);
```

### Drive the panel via commands

The fragment registers handlers for the `ai-config:*` commands, so UI can stay decoupled from the adapter:

```ts
import { UpsertConnectionCommand, RefreshModelsCommand } from "@statewalker/ai-config";
import { Commands } from "@statewalker/shared-commands";

const commands = workspace.requireAdapter(Commands);
await commands.call(UpsertConnectionCommand, {
  connection: { id: "anthropic", type: "anthropic", name: "Anthropic", starredModelIds: [] },
  apiKey: "sk-ant-…",
}).promise;
```

`ConfigureAiCommand` is the deep-link to open the settings dialog on the connections tab (handled by the renderer).

## Internals

### Architectural decisions

- **`AiConfig` is an abstract class, not an interface**, so it doubles as the registry key (`workspace.requireAdapter(AiConfig)`) and the published contract. `AiConfigImpl` holds one in-memory `AiConfigData`, persists it credential-free, and routes every credential through `Secrets`.
- **Connection shells survive disconnect.** `disconnect()` deletes the stored key and clears `discoveredModels`/`discoveredAt`/`starredModelIds` but keeps the id/type/name/url/headers so the user can re-connect with one click. `removeConnection()` deletes everything including the secret.
- **`openai-compatible` escape hatch.** Beyond the three canonical providers, an `openai-compatible` connection targets arbitrary proxies/self-hosted endpoints; its `url` is mandatory (the endpoint *is* the configuration).
- **Capabilities are tagged locally.** The `/v1/models` endpoints don't reliably surface capability metadata, so `capabilities.ts` carries a curated id-pattern → tag table (embeddings/image-gen/tts), defaulting unknown ids to `["chat"]` so exotic models stay usable.

### Algorithms

- **Legacy-key migration (idempotent).** `loadAiConfig` parses the document; any connection still carrying a plaintext `apiKey` has it reported via the `onLegacyKey` callback (the impl writes it to `Secrets`) and stripped. The schema is normalised to v6 and the stripped document is re-persisted, so the migration runs at most once.
- **Default-starred seeding.** `applyDefaultStarred(type, modelIds)` compiles a curated per-type glob table (`*` → `.*`, case-insensitive, anchored) into memoised `RegExp`s and returns the discovered ids that match, preserving discovery order. Applied **only** on the first successful connect (when `starredModelIds` is empty); re-discovery never re-applies it, so user un-stars are durable. `openai-compatible` ships no defaults by design.
- **Discovery** issues a `GET …/models` per provider with provider-specific auth (`Authorization: Bearer` for OpenAI/compatible, `x-api-key` + `anthropic-version` for Anthropic, `?key=` for Google), merges any per-connection headers, filters Google models to those supporting `generateContent`, and surfaces non-2xx bodies (truncated to 512 chars) as `Error`s.

### Constraints

- Discovery uses the global `fetch` and talks to live provider endpoints; it throws on non-2xx/network failure. `anthropic` (CORS) and `openai-compatible` require a `url`.
- The config document is schema v6 (`AI_CONFIG_SCHEMA_VERSION`); only the legacy-plaintext-key shape is migrated.
- `LocalModelRef` entries are recorded in the document but loading local models is out of scope (owned by the local-model lifecycle package).

### Dependencies

- `@statewalker/workspace.core` — `Workspace`, `Secrets`, the adapter host and lifecycle hooks; credentials live in `Secrets`.
- `@statewalker/webrun-files` — `FilesApi` plus `tryReadText`/`writeText` for the credential-free JSON store.
- `@statewalker/shared-commands` — the `ai-config:*` command definitions and bus.
- `@statewalker/shared-registry` — `newRegistry` for scoped cleanup.
- `@ai-sdk/openai` / `@ai-sdk/anthropic` / `@ai-sdk/google` / `@ai-sdk/provider` — provider construction (`ProviderV3`), inlined to avoid a workbench ↔ ai cycle.
- `@json-render/core` — `Spec` typing for the connections panel contract.

## Related

- `@statewalker/ai-config.view.react` — the paired renderer: the React registry, components, action handlers, and the `AiConfig → state` bridge for the "Remote Models" settings tab.
- `@statewalker/ai-agent-runtime` — the agent-runtime fragment whose `ActiveModel` pointer is fed from this config's active selection.
- `@statewalker/workspace.core` — the workspace/`Secrets` substrate.

## License

MIT — see the monorepo root `LICENSE`.
