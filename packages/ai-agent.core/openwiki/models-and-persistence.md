# Models & Persistence

How the runtime manages model providers, local model lifecycle, and session persistence.

## Model providers

`AgentRuntime.addModelProvider(...providers)` registers one or more `ProviderV3` instances. At `build()`, the runtime resolves the provider (currently: first registered provider wins; TODO: union of multiple providers).

```ts
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";

const runtime = await new AgentRuntime({ files })
  .addModelProvider(createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY }))
  // .addModelProvider(createOpenAI({ apiKey: ... }))  // currently: first wins
  .build();
```

Cloud providers (Anthropic/OpenAI/Google) are passed in directly as `ProviderV3`. Local-engine models go through `ModelManager` → `ModelStateStore` (which implements `ProviderV3`).

**Source**: `src/runtime/agent-runtime.ts` (`addModelProvider`, `_resolveProvider`), `src/runtime/types.ts` (`ModelProviderInput`).

## ModelManager

Operations controller for local model activation lifecycle. Performs external API calls (provider creation, verification, downloads) and updates `ModelStateStore` at each step. UI controllers should subscribe to `ModelStateStore`, not to `ModelManager`.

```ts
class ModelManager {
  readonly store: ModelStateStore;
  readonly files: FilesApi | undefined;
  get provider(): ProviderV3;  // returns this.store — pass to AgentRuntime.addModelProvider()

  registerEngine(engineId: string, registration: LocalEngineRegistration): void;
  async download(config: LocalModelConfig, signal?: AbortSignal): Promise<void>;
  async activate(config: LocalModelConfig): Promise<LanguageModelV3>;
  async verifyAccess(modelId: string): Promise<boolean>;
  async listRemoteModels(settings: RemoteProviderSettings): Promise<DiscoveredModel[]>;
}
```

### Local engine registration

```ts
interface LocalEngineRegistration {
  factory: LocalModelFactory;        // creates LanguageModelV3 instances
  fileResolver?: FileResolver;       // custom download file listing (e.g. MLC shards)
  verifier?: WeightVerifier;         // custom weight-presence check
  engineHasWeights?: (config: LocalModelConfig, files: FilesApi | undefined) => Promise<boolean>;
}
```

The `engineHasWeights` hook takes precedence over the default `LocalModelStorage.hasWeights(verifier)` path — use it when the default metadata-file check is wrong for your engine (e.g., WebLLM streams weights directly without going through `LocalModelStorage.download`).

**Source**: `src/models/model-manager.ts`, `src/models/types.ts`.

## ModelStateStore

Observable data model for model catalog, states, and active model instances. Pure state container — no external API calls, no I/O. Controllers subscribe via `onUpdate()` to react to state changes.

Also implements `ProviderV3` so it can be passed directly to `AgentRuntime.addModelProvider()`:

- `specificationVersion = "v3"`
- `languageModel(id)` — returns the active `LanguageModelV3` for the model id.
- `embeddingModel` / `imageModel` — throw `NoSuchModelError`.

```ts
class ModelStateStore implements ProviderV3 {
  constructor(catalog: Record<string, ModelConfig>);
  onUpdate(cb: () => void): () => void;
  get catalog(): Record<string, ModelConfig>;
  // ... state accessors, model instance management
}
```

### Model states

Each model in the catalog has a `ModelState`:

```ts
interface ModelState {
  config: ModelConfig;
  status: ModelStatus;  // "not-downloaded" | "downloading" | "ready" | ...
}
```

**Source**: `src/models/model-state-store.ts`, `src/models/types.ts` (`ModelConfig`, `ModelState`, `ModelStatus`).

## LocalModelStorage

Manages on-disk weight storage for local models under a configurable `FilesApi` and base path (default: `/models`).

- **Download** — fetches weight files via a `FileResolver` and stores them.
- **Verification** — checks weight presence via a `WeightVerifier` (defaults to ONNX file check).
- **Metadata** — writes a metadata file on download, used by the default `hasWeights` check.

**Source**: `src/models/local-model-storage.ts`.

## Remote discovery

`listModels(settings: RemoteProviderSettings)` queries remote provider APIs to discover available models. Returns `DiscoveredModel[]` that can be merged into the catalog via `mergeCatalogs` or used to configure `createDefaultCatalog`.

**Source**: `src/models/remote-discovery.ts`, `src/models/model-catalog.ts` (`createDefaultCatalog`, `mergeCatalogs`).

## verifyModelAccess

```ts
async function verifyModelAccess(provider: ProviderV3, modelId: string): Promise<boolean>;
```

Tests whether the provider can actually serve the model — useful for connection validation after configuration.

**Source**: `src/models/verify-model.ts`.

## Session persistence

### FilesSessionManager

Persists sessions by id under `<sessionsDir>/<id>/<id>.md` plus a shared `<sessionsDir>/index.json`. Each session is serialized to markdown via the [stream serializer](conversation-state.md#serialization).

```ts
class FilesSessionManager {
  constructor(files: FilesApi, sessionsDir?: string, factory?: NodeFactory);
  async save(id: string, session: SessionState): Promise<void>;
  async load(id: string): Promise<SessionState>;
  async list(): Promise<SessionMetadata[]>;
  async delete(id: string): Promise<boolean>;
  async exists(id: string): Promise<boolean>;
  async setModelRef(id: string, modelRef: SessionModelRef | null): Promise<void>;
  async getMetadata(id: string): Promise<SessionMetadata | undefined>;
}
```

### Storage layout

```
<sessionsDir>/
├── index.json                    # session index (id, title, createdAt, updatedAt, modelRef)
├── <session-id-1>/
│   └── <session-id-1>.md         # serialized session tree (markdown)
├── <session-id-2>/
│   └── <session-id-2>.md
└── ...
```

### Session metadata

```ts
interface SessionMetadata {
  id: string;
  title: string;
  createdAt: string;    // ISO timestamp
  updatedAt: string;    // ISO timestamp
  modelRef?: SessionModelRef;
}

interface SessionModelRef {
  connectionId: string;
  modelId: string;
}
```

`list()` returns sessions sorted by `updatedAt` descending (newest first). `setModelRef` is called by the chat composer's model dropdown on user selection.

### Runtime integration

`AgentRuntime` constructs a `FilesSessionManager` during `build()` with the system-view `FilesApi` and the resolved sessions path. Session lifecycle methods:

| Method | Purpose |
|---|---|
| `runtime.loadSession(id)` | Load and resume a session. Binds to the registered Agent matching the persisted `agent` prop; falls back to a synthetic `__resumed__` Agent. |
| `runtime.listSessions()` | List session metadata (newest first). |
| `runtime.deleteSession(id)` | Delete a session by id. |
| `runtime.setSessionModelRef(id, ref)` | Set/clear per-session model selection. |
| `runtime.getSessionMetadata(id)` | Read a session's metadata. |

### Session save

`Session.save({ title? })` calls the runtime's `saveSession(id, state)` which delegates to `FilesSessionManager.save()`. The session tree is serialized to markdown and written to `<sessionsDir>/<id>/<id>.md`; the index is updated with the title and `updatedAt`.

**Source**: `src/sessions/files-session-manager.ts`, `src/sessions/metadata.ts`, `src/runtime/agent-runtime.ts` (`loadSession`, `listSessions`, `deleteSession`, `saveSession`).

## ConfigManager

JSON config load/save over `FilesApi` with optional Zod schema validation.

```ts
class ConfigManager {
  constructor(files: FilesApi, basePath?: string);
  async load<T>(path: string, schema?: ZodType<T>): Promise<T | undefined>;
  async save(path: string, data: unknown): Promise<void>;
  async exists(path: string): Promise<boolean>;
  async delete(path: string): Promise<boolean>;
}
```

Accessible via `runtime.config`. Uses the system-view `FilesApi` with the resolved config path (default: `/`).

**Source**: `src/config/config-manager.ts`.
