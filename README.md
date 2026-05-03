# statewalker-ai

AI agent and provider stack for the statewalker ecosystem. Published as the `@statewalker/ai-*` package set; orchestrated via the umbrella (see `workspaces/statewalker-ai` in the umbrella's `repos.json`).

## Packages

| Package | Description |
| --- | --- |
| [`@statewalker/ai-agent`](packages/ai-agent) | Agent loop, builder, session models, MCP client, Vercel AI SDK tool wiring. Includes the reactive tree infrastructure (TreeNode, factory, serialization) under `./state`. |
| [`@statewalker/ai-agent-tests`](packages/ai-agent-tests) | Dev-only cross-implementation test harness for the agent loop. |
| [`@statewalker/ai-provider-core`](packages/ai-provider-core) | Provider lifecycle, active-models controller, UI wiring for the model picker. Owns the AI-config fragment. |
| [`@statewalker/ai-provider-core-browser`](packages/ai-provider-core-browser) | Workspace activator that registers browser engines on the shared `ModelManager`. |
| [`@statewalker/ai-provider-core-node`](packages/ai-provider-core-node) | Workspace activator that registers Node engines on the shared `ModelManager`. |
| [`@statewalker/ai-provider-browser`](packages/ai-provider-browser) | Browser inference engines: WebLLM (MLC) + transformers.js, plus WebLLM weight-bridge helpers. |
| [`@statewalker/ai-provider-node`](packages/ai-provider-node) | Node inference engine: llama.cpp via `node-llama-cpp`. |

`ai-agent-tests` is a dev-only test harness that exercises every other package's public surface in combination; it is not published as a runtime dependency.

## Development

```sh
pnpm install
pnpm run build
pnpm run test
```

Note: cross-repo `@statewalker/*` dependencies (e.g. `@statewalker/shared-baseclass`, `@statewalker/fsm`) are resolved through the umbrella's `workspaces/*/packages/*` pnpm glob. Building standalone requires those to be present either as npm publishes or as sibling umbrella clones.
