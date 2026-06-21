# @statewalker/ai-openai-compat

Wire-format adapter that exposes any [Vercel AI SDK v6](https://sdk.vercel.ai/)
`LanguageModelV3` / `EmbeddingModelV3` provider over the OpenAI HTTP v1 API as
a standard Web Fetch handler.

## What it is

A single function — `createOpenAICompat(init)` — that returns a handler of
type `(req: Request) => Promise<Response>`. The handler implements the
OpenAI v1 endpoint surface most clients actually use:

| Method | Path                    | Backed by                            |
| ------ | ----------------------- | ------------------------------------ |
| GET    | `/models`               | `Object.keys` of the registries      |
| POST   | `/chat/completions`     | `generateText` / `streamText`        |
| POST   | `/completions` (legacy) | `generateText` / `streamText`        |
| POST   | `/embeddings`           | `embedMany` (single input → length-1)|

The path prefix is configurable (`basePath`, default `/v1`). Authentication,
rate limiting, logging, and metrics are not handled in the adapter — they
belong to whatever transport middleware sits in front of it. The lib has
**zero HTTP-transport dependency**: no Hono, no Express, no Node `http`.
It works equally well in Cloudflare Workers, Bun, Deno, or behind a Node
`http`/Hono/Fastify adapter.

## Why it exists

The Vercel AI SDK normalises access to many backends (local llama.cpp,
hosted OpenAI / Anthropic / Google / Groq / Mistral, browser-side Web LLM,
custom providers, …) behind a single provider abstraction. But the
*de-facto* wire protocol for inference clients — the official `openai` SDK,
curl, IDE plugins, the entire ecosystem of "set `OPENAI_API_KEY` and a
`baseURL`" tools — is still OpenAI v1 HTTP. Every project that wants to
front a non-OpenAI backend with that wire format ends up reinventing the
same translation layer.

This package extracts that translation layer once and ships it as a pure
fetch handler. Concretely it replaces:

- Bespoke per-app "OpenAI shim" glue (each subtly wrong in different ways
  around finish reasons, SSE chunk shapes, tool-call deltas, multimodal
  parts).
- The need to depend on Hono just to expose a model — the consumer brings
  its own transport.
- Reaching for the `@ai-sdk/openai-compatible` provider when all the caller
  wants is "speak OpenAI on this URL".

## How to use

### Install

```sh
pnpm add @statewalker/ai-openai-compat ai @ai-sdk/provider
```

`ai` and `@ai-sdk/provider` are peer dependencies of the AI SDK ecosystem;
add whichever provider package(s) supply your models (`@ai-sdk/openai`,
`@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/mcp`, etc.).

### Minimal example

```ts
import { createOpenAICompat } from "@statewalker/ai-openai-compat";
import { createAnthropic } from "@ai-sdk/anthropic";

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const handler = createOpenAICompat({
  languageModels: {
    "claude-sonnet": anthropic("claude-sonnet-4-5-20250929"),
  },
});

// `handler` is a fetch function — drop it into any transport:
const res = await handler(
  new Request("http://x/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: "claude-sonnet",
      messages: [{ role: "user", content: "Hi" }],
    }),
  }),
);
console.log(await res.json());
```

### Mount on Hono

```ts
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { createOpenAICompat } from "@statewalker/ai-openai-compat";
import { createOpenAI } from "@ai-sdk/openai";

const llamacpp = createOpenAI({
  apiKey: "not-needed",
  baseURL: "http://127.0.0.1:8080/v1",
});

const handler = createOpenAICompat({
  languageModels: { "gemma-3-1b": llamacpp.chat("gemma-3-1b") },
});

const app = new Hono();
app.use("/v1/*", bearerAuth({ token: process.env.API_KEY! }));
app.all("/v1/*", (c) => handler(c.req.raw));

export default app;
```

### Drive with the official `openai` SDK

Once the handler is bound to any URL, you point any OpenAI client at it:

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "any",
  baseURL: "http://127.0.0.1:8787/v1",
});

const reply = await client.chat.completions.create({
  model: "gemma-3-1b",
  messages: [{ role: "user", content: "Hello" }],
});
```

## Examples

### Custom `basePath`

Mount under any prefix without URL rewriting on the transport side:

```ts
const handler = createOpenAICompat({
  basePath: "/api/openai",
  languageModels: { gpt: anthropic("claude-sonnet-4-5-20250929") },
});

// Matches POST http://x/api/openai/chat/completions
// Returns 404 on http://x/v1/chat/completions
```

### Streaming chat completions

`stream: true` returns an SSE response that is byte-for-byte the OpenAI
`chat.completion.chunk` format. The `openai` SDK consumes it natively:

```ts
const stream = await client.chat.completions.create({
  model: "claude-sonnet",
  messages: [{ role: "user", content: "Count to 5." }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta.content ?? "");
}
```

### Tool calls (streaming and non-streaming)

OpenAI tool definitions are forwarded as AI SDK `tools`; tool calls
returned by the model are emitted in either the non-streaming
`choices[0].message.tool_calls` shape or, when streaming, as per-index
`delta.tool_calls[]` chunks whose `function.arguments` deltas concatenate
to the original JSON string.

```ts
const reply = await client.chat.completions.create({
  model: "claude-sonnet",
  messages: [{ role: "user", content: "1+2?" }],
  tools: [
    {
      type: "function",
      function: {
        name: "sum",
        parameters: {
          type: "object",
          properties: {
            a: { type: "number" },
            b: { type: "number" },
          },
        },
      },
    },
  ],
});

const tc = reply.choices[0]?.message.tool_calls?.[0];
// { id: ..., type: "function", function: { name: "sum", arguments: '{"a":1,"b":2}' } }
```

### Multimodal input

`image_url`, `file`, and `input_audio` content parts on user messages
translate to AI SDK `ImagePart` / `FilePart`. The backend provider decides
whether to download, embed, or reject the URL.

```ts
await client.chat.completions.create({
  model: "claude-sonnet",
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "What is in this image?" },
        {
          type: "image_url",
          image_url: { url: "https://example.com/cat.png" },
        },
      ],
    },
  ],
});
```

### Legacy `/v1/completions`

Single-string prompt → single backend call → single `choices[0]`. Array
prompts fan out to N backend calls. Streaming requires a single string.

```ts
const reply = await client.completions.create({
  model: "claude-sonnet",
  prompt: "Hello",
});
// reply.choices[0].text
```

### Embeddings

```ts
const res = await client.embeddings.create({
  model: "my-embed",
  input: ["a", "b"],
});
// res.data[0].embedding, res.data[1].embedding
```

## API

| Export | Description |
| --- | --- |
| `createOpenAICompat(init: Init): (req: Request) => Promise<Response>` | The single entry point. Returns a standard fetch handler. |
| `Init` | `{ languageModels?: Record<string, LanguageModelV3>; embeddingModels?: Record<string, EmbeddingModelV3>; basePath?: string }` |
| `OpenAIError`, `OpenAIErrorCode`, `OpenAIErrorType`, `errorResponse(...)` | Re-exported from `./errors.js` so transports can emit identically-shaped errors. |

## Internals

### Architectural decisions

- **Fetch handler, not a Hono app.** The reference adapter
  [`@ns/ai-to-openai-hono`](https://jsr.io/@ns/ai-to-openai-hono) returns a
  Hono `App`. We instead return a pure `(req: Request) => Promise<Response>`
  because (a) it keeps the adapter usable in transports that never want a
  Hono dep (Workers, Bun, raw Node), and (b) routing four fixed paths is
  ~30 LOC of pathname-switch — cheaper than the import.
- **Record-only model registration.** `languageModels` / `embeddingModels`
  are `Record<id, Model>`. `/v1/models` derives the list from
  `Object.keys`. Dynamic / lazy resolvers were considered and rejected:
  they double the test matrix and require an additional `listModels()`
  callback to keep `/v1/models` truthful. Static config covers every real
  proxy-app case.
- **Auth delegated to transport.** The lib does not parse `Authorization`
  headers or maintain a key store. Wrap the handler in whatever middleware
  the host transport offers (`bearerAuth`, custom Workers `fetch`, etc.).
  This keeps the lib single-purpose and transport-agnostic.
- **Tool input schema passthrough.** OpenAI's `tools[].function.parameters`
  arrives as raw JSON Schema. We wrap it with `jsonSchema(...)` (re-exported
  from `ai`) and feed it to `tool({ inputSchema })`. The schema is forwarded
  to the underlying provider unchanged — no Zod parsing layer in between.
- **Error envelope is OpenAI's, not AI SDK's.** Every failure surfaces
  `{ error: { message, type, code, param? } }`. Upstream AI SDK errors
  collapse to `{ type: 'server_error', code: 'upstream_error' }` with the
  original `error.message`. Stack traces are never emitted.

### Layout

```
src/
├── index.ts                  ← createOpenAICompat (the router)
├── errors.ts                 ← OpenAI error envelope + Response factory
├── util.ts                   ← parseJsonBody / requireModelField / modelNotFound / upstreamError
├── openai-types.ts           ← OpenAI v1 request + response wire shapes
├── endpoints/
│   ├── models.ts             ← GET /v1/models
│   ├── chat-completions.ts   ← POST /v1/chat/completions (stream + non-stream)
│   ├── completions.ts        ← POST /v1/completions (legacy)
│   └── embeddings.ts         ← POST /v1/embeddings
└── translate/
    ├── messages.ts           ← OpenAI ChatMessage → AI SDK ModelMessage
    ├── tools.ts              ← tools[] / tool_choice → AI SDK ToolSet / ToolChoice
    ├── finish-reason.ts      ← AI SDK FinishReason → OpenAI finish_reason
    ├── usage.ts              ← LanguageModelUsage → { prompt_tokens, completion_tokens, total_tokens }
    └── stream-chunks.ts      ← TextStreamPart → OpenAI chat.completion.chunk emitter
```

### Streaming wire format

`POST /chat/completions` with `stream: true` returns
`Content-Type: text/event-stream; charset=utf-8` and a body that is a
sequence of `data: <json>\n\n` chunks terminated by `data: [DONE]\n\n`.

For one response:

- `id` is generated once (`chatcmpl-<uuid>`) and reused across every chunk.
- `created` is `Math.floor(Date.now() / 1000)` — integer seconds. (The
  reference adapter has a known bug where `created` is a float; we
  deliberately diverge.)
- `object` is `chat.completion.chunk` on every chunk.
- The terminal chunk (the one that carries `finish_reason`) is the only
  one with `usage`.

Tool-call streaming follows OpenAI's per-index delta convention:

- A `tool-input-start` event yields one chunk with
  `delta.tool_calls[i] = { index, id, type: 'function', function: { name, arguments: '' } }`.
- Each `tool-input-delta` event yields one chunk with
  `delta.tool_calls[i] = { index, function: { arguments: <delta> } }`.
- A bare `tool-call` event (no prior streaming deltas) yields one chunk
  carrying the full JSON-stringified arguments.

### Translation table — OpenAI → AI SDK v3

| OpenAI field                                       | AI SDK target                                  |
| -------------------------------------------------- | ---------------------------------------------- |
| `messages[].role: "system" \| "developer"`         | `{ role: "system", content: <text> }`          |
| `messages[].role: "user"`, string content          | `{ role: "user", content: <string> }`          |
| `messages[].role: "user"`, parts content           | `{ role: "user", content: TextPart \| ImagePart \| FilePart[] }` |
| user part `{ type: "text", text }`                 | `{ type: "text", text }`                       |
| user part `{ type: "image_url", image_url: { url } }` | `{ type: "image", image: new URL(url) }`    |
| user part `{ type: "file", file: { file_data } }`  | `{ type: "file", data, mediaType: "application/octet-stream" }` |
| user part `{ type: "input_audio", input_audio: { data, format } }` | `{ type: "file", data, mediaType: format === "mp3" ? "audio/mpeg" : "audio/wav" }` |
| `messages[].role: "assistant"`                     | `{ role: "assistant", content: [TextPart, ToolCallPart...] }` |
| `messages[].role: "tool"`                          | `{ role: "tool", content: [ToolResultPart] }`  |
| `tools[].function.{name, description, parameters}` | `tool({ description, inputSchema: jsonSchema(parameters) })` |
| `tool_choice: "auto" \| "none" \| "required"`      | passthrough                                    |
| `tool_choice: { type: "function", function: { name } }` | `{ type: "tool", toolName: name }`        |
| `temperature` / `top_p` / `frequency_penalty` / `presence_penalty` / `seed` | passthrough (snake_case → camelCase) |
| `max_completion_tokens` (preferred) / `max_tokens` | `maxOutputTokens`                              |
| `stop: string \| string[]`                         | `stopSequences: string[]`                      |

### Finish-reason mapping

| AI SDK `FinishReason` | OpenAI `finish_reason` |
| --------------------- | ---------------------- |
| `stop`                | `stop`                 |
| `length`              | `length`               |
| `content-filter`      | `content_filter`       |
| `tool-calls`          | `tool_calls`           |
| `error`               | `stop`                 |
| `other`               | `stop`                 |

### Error mapping

| Failure                                       | HTTP | `error.type`             | `error.code`            | `error.param` |
| --------------------------------------------- | ---- | ------------------------ | ----------------------- | ------------- |
| Path not matched / method wrong               | 404  | `invalid_request_error`  | `invalid_request_error` | —             |
| Body is not valid JSON                        | 400  | `invalid_request_error`  | `invalid_request_error` | —             |
| `model` field missing                         | 400  | `invalid_request_error`  | `invalid_request_error` | `model`       |
| `model` not registered                        | 404  | `invalid_request_error`  | `model_not_found`       | `model`       |
| `n > 1`                                       | 400  | `invalid_request_error`  | `invalid_request_error` | `n`           |
| `/completions` `stream: true` with array prompt | 400 | `invalid_request_error` | `invalid_request_error` | `prompt`     |
| `/embeddings` `input` is a token array        | 400  | `invalid_request_error`  | `invalid_request_error` | `input`       |
| Underlying AI SDK call throws                 | 500  | `server_error`           | `upstream_error`        | —             |

### Constraints

- **One vector per input on embeddings.** Token-array inputs (`number[]`,
  `number[][]`) are rejected — AI SDK works with strings, not token ids.
- **`n > 1` is rejected.** AI SDK does not expose a uniform multi-completion
  API across providers.
- **`logprobs` is always `null` on responses.** AI SDK does not surface
  token logprobs uniformly across providers.
- **`system_fingerprint` is omitted.** There is no uniform notion of a
  deterministic backend fingerprint across providers.
- **The Responses API (`/v1/responses`) is not implemented.** Modern
  `@ai-sdk/openai` defaults to it; callers backing the proxy with the
  OpenAI provider must use `provider.chat(modelId)` (or `provider.completion(modelId)`)
  to opt into Chat Completions, not the bare `provider(modelId)`.
- **No conversation persistence.** The adapter is stateless. History must
  be reconstructed on every request by the caller.

### Dependencies

| Package                | Why                                                   |
| ---------------------- | ----------------------------------------------------- |
| `ai`                   | `generateText`, `streamText`, `embedMany`, `jsonSchema`, `tool`, types. |
| `@ai-sdk/provider`     | `LanguageModelV3` / `EmbeddingModelV3` type surface used by `Init`. |

No HTTP transport, no Zod runtime, no `openai` SDK runtime dep. The `openai`
package only appears as a devDependency for integration tests that drive
the adapter through the real OpenAI client.

### Tests

Three tiers:

- **Unit (`tests/unit/`)** — synthetic `LanguageModelV3` / `EmbeddingModelV3`
  mocks, no I/O. Asserts every wire-format invariant at the `Response`
  level (status, headers, body, SSE chunks).
- **Integration (`tests/integration/`)** — wires the real
  `@ai-sdk/openai` provider against an in-memory mock OpenAI server (a
  custom `fetch` returning canned ChatCompletion / SSE / embedding JSON)
  and drives it through the official `openai` SDK to validate the round-trip
  preserves OpenAI semantics on both ends.
- **App e2e** — see `@repo/openai-proxy-app` in `statewalker-apps` for the
  llama.cpp + Gemma 3 1B end-to-end harness (env-gated by `OPENAI_COMPAT_E2E=1`).

## Related

- [Vercel AI SDK](https://sdk.vercel.ai/) — the underlying model abstraction.
- [@ns/ai-to-openai-hono](https://jsr.io/@ns/ai-to-openai-hono) — the
  Hono-coupled reference adapter this package was inspired by (we diverge
  on transport coupling, basePath, error envelope, and AI SDK v6 alignment).

## License

MIT.
