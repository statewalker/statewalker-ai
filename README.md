# statewalker-ai

## What it is

A pnpm monorepo with the AI layer of StateWalker: an agent library (`@statewalker/ai-agent.core`), workspace fragments that host the agent and manage AI configuration and local models, a browser engine for local models, and an adapter that serves AI SDK models over the OpenAI HTTP API. It contains no React code. All six packages are published to npm under `@statewalker/*`.

## Layout

```
packages/
  ai-agent.core/              agent library: AgentRuntime → Agent → Session (no workspace dependency)
  ai-agent-runtime.core/      fragment: keeps a live AgentRuntime, rebuilds it on input changes
  ai-config.core/             fragment: provider connections, discovered models, active selection
  ai-local-models.core/       fragment: local model catalog, downloads, local selection
  ai-local-models.browser/    transformers.js engine registered on a ModelManager (browser only)
  ai-openai-compat.core/      OpenAI HTTP v1 API as a fetch handler over AI SDK models
```

| Package | What it gives you |
| --- | --- |
| [`@statewalker/ai-agent.core`](packages/ai-agent.core) | Agent loop, conversation state tree, context shaping, file tools, MCP, model management. |
| [`@statewalker/ai-agent-runtime.core`](packages/ai-agent-runtime.core) | `AgentRuntimeAdapter` with a ready-to-use `AgentRuntime`, plus slots for tools, skills, prompt text and MCP servers. |
| [`@statewalker/ai-config.core`](packages/ai-config.core) | `AiConfig` adapter; API keys kept in the workspace `Secrets` adapter. |
| [`@statewalker/ai-local-models.core`](packages/ai-local-models.core) | `LocalModels` adapter and the "Local Models" settings tab. |
| [`@statewalker/ai-local-models.browser`](packages/ai-local-models.browser) | `registerLocalProvider` for transformers.js models. |
| [`@statewalker/ai-openai-compat.core`](packages/ai-openai-compat.core) | `createOpenAICompat(init)`: `(req: Request) => Promise<Response>`. |

How the packages depend on each other:

```
ai-agent.core ◄── ai-agent-runtime.core ◄── ai-local-models.core ──► ai-local-models.browser
      ▲                                                                      │
      └──────────────────────────────────────────────────────────────────────┘
ai-config.core          (independent; builds @ai-sdk providers itself)
ai-openai-compat.core   (independent; depends only on ai and @ai-sdk/provider)
```

Other `@statewalker` packages used here: `@statewalker/workspace.core`, `@statewalker/settings.core`, `@statewalker/shared-baseclass`, `@statewalker/shared-commands`, `@statewalker/shared-ids`, `@statewalker/shared-registry`, `@statewalker/shared-slots`, `@statewalker/webrun-files`, `@statewalker/webrun-files-composite`, `@statewalker/fsm`; in tests also `@statewalker/webrun-files-mem` and `@statewalker/fsm-validator`.

## How to run it

1. Install Node.js 24.
2. Enable corepack so the pinned pnpm (`packageManager: pnpm@10.16.1`) is used: `corepack enable`.
3. `pnpm install`
4. `pnpm build` — tests and typechecks of dependent packages import the built `dist/` of their workspace dependencies.
5. `pnpm test`

Before pushing, run what CI runs: `pnpm lint:check`, `pnpm format:check`, `pnpm build`, `pnpm typecheck`, `pnpm test`.

## Why it is the way it is

- **`.core` packages are platform-neutral; `.browser` packages are browser-only.** The transformers.js engine needs WASM, Service Workers and multi-gigabyte downloads, so it sits in `ai-local-models.browser` and its engine SDKs are optional peer dependencies. Everything else runs in browsers and Node.
- **The agent library does not know about the workspace.** `ai-agent.core` takes a `FilesApi` and model providers and nothing else. The workspace glue (adapters, slots, commands, rebuilds) is in `ai-agent-runtime.core`, so the library can be used in a CLI or server as well.
- **Fragments are logic-only.** Each fragment exports a default `init(ctx)` from `./fragment` that registers adapters and command handlers on the workspace. React views for them are separate packages (`@statewalker/ai-config.view.react`, `@statewalker/ai-local-models.view.react`).
- **Credentials never go into config files.** `ai-config.core` keeps keys in the workspace `Secrets` adapter and reads them only when it builds a provider or lists models.
- **`ai-config.core` builds providers with `@ai-sdk/*` directly** instead of going through `ai-agent.core`, so the two packages have no dependency on each other.

## What will surprise you

- **The `ai-agent.core` package root exports nothing.** `import { AgentRuntime } from "@statewalker/ai-agent.core"` fails with `Module '"@statewalker/ai-agent.core"' has no exported member 'AgentRuntime'.` Import from `@statewalker/ai-agent.core/runtime` (or `/state`, `/models`, `/tools`).
- **The `ai-local-models.browser` package root also exports nothing.** Only `@statewalker/ai-local-models.browser/transformers` is reachable. The WebLLM code in `src/webllm/` ships in the package but is not exported.
- **`Session.run()` does not end after a reply.** It waits for the next inbox message until its `AbortSignal` aborts. A `for await` loop over it never exits on its own; break on the `turn-finish` log message or pass a signal.
- **`pnpm typecheck` before `pnpm build` fails** with `Cannot find module '@statewalker/ai-agent.core/runtime' or its corresponding type declarations.` Package `exports` point at `dist/`, and there is no source-condition shortcut. Run `pnpm build` first (`pnpm -r` builds in dependency order).

## Reference

### Commands

| Command | What it does |
| --- | --- |
| `pnpm build` | `tsdown` in every package |
| `pnpm test` | `vitest run` in every package |
| `pnpm typecheck` | `tsc --noEmit` in every package |
| `pnpm lint` / `pnpm lint:check` | `biome check --write .` / `biome check .` |
| `pnpm format` / `pnpm format:check` | `biome format --write .` / `biome format .` |
| `pnpm changeset` | add a changeset (choose the bump and the changelog text) |

### Dependencies and publishing

Internal dependencies use `workspace:^`. External dependencies use the pnpm catalog in `pnpm-workspace.yaml` (`catalog:`; optional peers use `catalog:peers`). Each package ships `dist/` (JavaScript and `.d.ts`) and its TypeScript `src/`; `exports` point at `dist/`.

Packages are published to npm from CI with changesets. After CI passes on `main`, a job writes changesets for packages whose packed contents differ from npm and opens a "chore: version packages" PR; merging it publishes with npm provenance. Renovate opens dependency update PRs.

### License

MIT. See [LICENSE](LICENSE).
