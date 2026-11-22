# @statewalker/ai-host-do

## What it is

The deployment: the Durable Object classes (Issuer, Workspace, User, Profiles, AgentSession,
Database) and the Worker serving the session API (REST, SSE, RPC on WebSockets), the same code on
CellB (browser and Node), CellD and Cloudflare Workers. `@statewalker/ai-host-do/browser` builds a
browser deployment's configuration: it holds no deployment key (`SECRETS_KEY`,
`DEPLOYMENT_SECRETS`) and keeps only its users' own secrets.

Part of the AI harness (statewalker/statewalker-root#111): see the
[repository's README](https://github.com/statewalker/statewalker-ai#readme), its
[glossary](https://github.com/statewalker/statewalker-ai/blob/main/GLOSSARY.md) and its
[threat table](https://github.com/statewalker/statewalker-ai/blob/main/docs/security.md).

## How to use it

```sh
npm install @statewalker/ai-host-do
```

A Worker project re-exports the classes and the Worker:

```ts
// src/worker.ts
export { AgentSession, Database, Issuer, Profiles, User, Workspace } from "@statewalker/ai-host-do";
export { worker as default } from "@statewalker/ai-host-do";
```

Its `wrangler.jsonc` binds the six classes (ISSUER, WORKSPACE, USER, PROFILES, AGENT, DATABASE)
and sets the variables this package's `wrangler.jsonc` documents. One deployment-level provider is
a `MODELS` with one provider, its key a deployment secret bound to the `model-gateway` plugin and
the provider's host:

```jsonc
"vars": {
  "MODELS": "{\"providers\":[{\"id\":\"anthropic\",\"api\":\"anthropic-messages\",\"baseUrl\":\"https://api.anthropic.com\",\"secret\":\"ANTHROPIC_KEY\"}],\"models\":[{\"id\":\"anthropic/claude-haiku-5-5\",\"alias\":\"default\"}],\"default\":\"default\"}"
}
// runtime secrets: SECRETS_KEY, ANTHROPIC_KEY, and
// DEPLOYMENT_SECRETS = {"ANTHROPIC_KEY": {"plugins": ["model-gateway"], "hosts": ["api.anthropic.com"]}}
```

The harness is reached by clients through the session API of a running deployment, not through
these packages; they are the deployment's parts.
