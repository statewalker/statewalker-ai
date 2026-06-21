# Model references are `connectionId:modelId` URIs resolved through a provider registry

A model is named across AiConfig connections by a URI `connectionId:modelId` —
the **Connection.id** (not the provider *type*, since two connections can share a
type), a colon, then the opaque model id (which may itself contain `/` or `:`; the
URI is split on the **first** colon only). Resolution is the Vercel AI SDK's
`createProviderRegistry`, keyed by connection id, so `registry.languageModel(uri)` /
`registry.textEmbeddingModel(uri)` resolve synchronously — matching wiki's
`LlmProvider` shape with no interface change. The registry is rebuilt on
`AiConfig.onUpdate` so key/connection edits take effect without re-registration.

## Considered Options

- **`connectionId:modelId` (chosen)** — matches `createProviderRegistry`'s default
  separator verbatim, so the bridge is the SDK registry itself; first-colon split
  keeps namespaced model ids like `proxyA:openai/gpt-4.1` intact.
- **Gateway `author/model` (OpenRouter/AI-Gateway/LiteLLM style)** — rejected: the
  prefix there names the model's *creator namespace*, but we must name a *configured
  endpoint with credentials*, and `/` collides with slash-bearing model ids.

## Consequences

- Connection ids MUST NOT contain `:` — validate at config-write time.
- The URI scheme is provider-neutral and lives in `ai-config` (not wiki), so chat
  can adopt the same vocabulary later. Wiki's `WikiLlmConfiguration` stores one URI
  per stage plus an embedding URI; the embed stage resolves via `textEmbeddingModel`,
  all other stages via `languageModel`.
