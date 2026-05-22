# statewalker-ai

AI agent and provider stack for the statewalker ecosystem. Published as the `@statewalker/ai-*` package set; orchestrated via the umbrella (see `workspaces/statewalker-ai` in the umbrella's `repos.json`).

## Packages

| Package | Description |
| --- | --- |
| [`@statewalker/ai-agent`](packages/ai-agent) | Pure logic core. Sub-path exports: `/state` (tree-node infrastructure, session state, serialization), `/runtime` (`AgentRuntime`, `Agent`, `Session`), `/models` (`ModelManager`, `ModelStateStore`, `createRemoteProvider`, catalog, verification), `/tools` (`createFileTools`, path utilities). MCP integration, sessions, skills, config live under deep imports as implementation detail. |
| [`@statewalker/ai-agent-runtime`](packages/ai-agent-runtime) | Workspace-fragment shim. Registers the `ActiveModel` and `AgentRuntimeAdapter` adapters and owns the re-entrant `AgentRuntimeManager`. Exposes `agentToolsSlot` for cross-package tool contribution. Boots before `ai-providers`. |
| [`@statewalker/ai-providers`](packages/ai-providers) | Workspace-fragment. Owns provider config storage (`Providers` adapter, `providers.json` IO), writes `ActiveModel`, contributes to `providers:remote`. Re-exports types (`ConnectionType`, `Capability`, `Connection`) and helpers (`isConnected`, `listConnectionModels`, `createRemoteProvider`). Boots after `ai-agent-runtime`. |
| [`@statewalker/models-config`](packages/models-config) | Workspace-fragment. Connections / starred / local-model lifecycle (`LocalModels`), json-render dialog specs (connections, starred, local-models tabs), commands. Logic-only per ADR 0002. |
| [`@statewalker/models-config-react`](packages/models-config-react) | React renderer for the models-config dialogs and composer model picker. Pairs with `models-config` (logic). |
| [`@statewalker/ai-provider-browser`](packages/ai-provider-browser) | Browser inference engines: WebLLM (MLC) and transformers.js, plus WebLLM weight-bridge helpers. Registers against `ai-agent`'s `ModelManager` via `registerLocalProvider`. |

## Development

```sh
pnpm install
pnpm run build
pnpm run test
```

Note: cross-repo `@statewalker/*` dependencies (e.g. `@statewalker/shared-baseclass`, `@statewalker/fsm`) are resolved through the umbrella's `workspaces/*/packages/*` pnpm glob. Building standalone requires those to be present either as npm publishes or as sibling umbrella clones.
