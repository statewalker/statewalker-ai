# statewalker-ai

## What it is

The AI harness of StateWalker: agents working over a user's files and data, on CellB (browser and
Node), CellD and Cloudflare Workers, with every resource reached through capabilities. It is being
built from the spec "the AI harness on CellB, CellD and Workers"
([statewalker/statewalker-root#111](https://github.com/statewalker/statewalker-root/issues/111)),
one ticket at a time. Terms are in [`GLOSSARY.md`](GLOSSARY.md); security properties and their
tests in [`docs/security.md`](docs/security.md).

## Layout

```
packages/
  ai-environment/    files, databases, executors, tools, model gateway, store, secrets
  ai-access/         tokens, roles, permissions, modes, approvals, risk classifier
  ai-definitions/    plugin loader, catalog, definitions mount, tool definitions
  ai-sessions/       user and agent sessions, turns, items, summaries, event log, session API
  ai-flue/           Flue on the environment
  ai-host-do/        Durable Objects, REST and RPC, runtime bindings
  ai-openai-compat/  OpenAI projection
  ai-uhp/            UHP projection
  ai-uhp-client/     remote agent sessions over UHP
  ai-conformance/    (private) conformance suite: deployments on CellB in-process, the scripted
                     model, the threat-table check
```

The packages are private skeletons until their tickets give them content; a package's first
version is published once, by a human, and later releases go through CI (statewalker-root's
release rules).

The previous agent stack is removed from this repository; its published versions stay on npm.
What replaces each package:

| Removed package | Replaced by |
|---|---|
| `@statewalker/ai-agent.core` | `ai-sessions` (sessions, turns, items, compaction) and `ai-flue` (the agent loop, Flue) |
| `@statewalker/ai-agent-runtime.core` | `ai-host-do` and `ai-sessions`: the harness is reached through the session API, not a workbench fragment |
| `@statewalker/ai-config.core` | the model gateway and secrets in `ai-environment` |
| `@statewalker/ai-local-models.core` | the gateway's `local` provider in `ai-environment` |
| `@statewalker/ai-local-models.browser` | the gateway's `local` provider in `ai-environment` (browser engines) |
| `@statewalker/ai-openai-compat.core` | `ai-openai-compat` |

## How to run it

1. Install Node.js 24 and enable corepack (`corepack enable`), so the pinned pnpm is used.
2. `pnpm install`
3. `pnpm test`: unit tests, and the conformance suite on CellB Node in-process.

Before pushing, run what CI runs: `pnpm lint:check`, `pnpm format:check`, `pnpm build`,
`pnpm typecheck`, `pnpm test`.

The slow and costly checks run every night, never on pull requests
([`.github/workflows/nightly.yml`](.github/workflows/nightly.yml)); each failing job files an issue
here. Locally: `pnpm test:nightly` runs `ai-conformance`'s `tests/nightly` (keep it small with
`NIGHTLY_FILE_BYTES`, `NIGHTLY_STREAMS`, `NIGHTLY_STREAM_BYTES`; the real-model tests run only with
`NIGHTLY_LLM_API_KEY`), and `node packages/ai-conformance/src/nightly/mutate.ts
packages/ai-conformance/mutations.json` runs the mutation run on the gate and `ai-access`.

## Why it is the way it is

- **Layer L3.** The harness depends only on `webrun-biscuit`, `webrun-wire`, `webrun-files`,
  `webrun-files-rpc`, `webrun-bundler`, Flue and pi; runtimes are dev and test dependencies
  (statewalker-root ADR `2026-11-16-harness-in-statewalker-ai`).
- **Tests first, at one seam.** Behaviour is proven by the conformance suite against a live
  deployment through the session API, on every runtime; package tests only where that seam is too
  coarse.
