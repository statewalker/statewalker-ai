# LLM/embedding calls go directly from the browser to the provider

The workbench calls model providers (OpenAI/Google/Anthropic/…) **directly from the
browser**, with API keys read client-side from the `Secrets` adapter. There is no
required server-side proxy: chat already works this way, and wiki — including in-app
indexing, which is N documents × several LLM/embedding stages — inherits the same
path by sharing AiConfig's connections. This is a deliberate architectural
constraint, not an incidental one.

## Considered Options

- **Direct browser → provider (chosen)** — no backend needed to run the app; the
  workbench stays a serverless static client. Keys live in the browser.
- **Mandatory server-side proxy** — rejected as a *requirement*: it would force a
  backend on every deployment and contradict the serverless shell model.

## Consequences

- Keys are exposed in the browser. Acceptable here: a single-user local-first
  workbench, keys held in `Secrets`, never committed (see ADR-0001's credential
  handling). Multi-tenant hosting would need to revisit this.
- Proxying remains **optional and per-connection**, expressed as a `Connection`
  (an `openai-compatible` endpoint or a `url` override — also how browser-CORS
  providers like Anthropic are reached). The model-reference URI can target it
  (`proxyA:openai/gpt-4.1`). The integration neither mandates nor precludes a proxy.
- Indexing amplifies cost/volume (not a new trust boundary — chat already exposes
  the key); surface progress/cost in the indexer UI rather than changing the model.
