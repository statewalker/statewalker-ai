# statewalker-ai

AI agent and provider stack for the statewalker ecosystem. Published as the `@statewalker/ai-*` package set; orchestrated via the umbrella (see `workspaces/statewalker-ai` in the umbrella's `repos.json`).

## Packages

| Package | Description |
| --- | --- |
| [`@statewalker/ai-agent`](packages/ai-agent) | Agent loop, builder, session models, MCP client, Vercel AI SDK tool wiring. |
| [`@statewalker/ai-agent-state`](packages/ai-agent-state) | Reactive tree infrastructure for agent session state. |
| [`@statewalker/ai-agent-tests`](packages/ai-agent-tests) | Dev-only cross-implementation test harness for the agent loop. |
| [`@statewalker/ai-provider`](packages/ai-provider) | Provider abstraction plus remote provider adapters (Anthropic, OpenAI, Google). |
| [`@statewalker/ai-provider-core`](packages/ai-provider-core) | Provider lifecycle, active-models controller, UI wiring for the model picker. |
| [`@statewalker/ai-provider-llamacpp`](packages/ai-provider-llamacpp) | llama.cpp local-inference provider. |
| [`@statewalker/ai-provider-local`](packages/ai-provider-local) | Local-inference provider backed by `@huggingface/transformers`. |
| [`@statewalker/ai-provider-webllm`](packages/ai-provider-webllm) | MLC WebLLM browser-inference provider. |

`ai-agent-tests` is a dev-only test harness that exercises every other package's public surface in combination; it is not published as a runtime dependency.

## Development

```sh
pnpm install
pnpm run build
pnpm run test
```

Note: cross-repo `@statewalker/*` dependencies (e.g. `@statewalker/shared-baseclass`, `@statewalker/fsm`) are resolved through the umbrella's `workspaces/*/packages/*` pnpm glob. Building standalone requires those to be present either as npm publishes or as sibling umbrella clones.
