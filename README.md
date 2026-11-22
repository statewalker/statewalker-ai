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
apps/
  workbench/         (private) a terminal in a browser page, a client of the session API; the
                     harness runs in the page on CellB
packages/
  ai-environment/    files, databases, executors, tools, model gateway, store, secrets
  ai-access/         tokens, roles, permissions, modes, approvals, risk classifier
  ai-definitions/    plugin loader, catalog, definitions mount, tool definitions
  ai-sessions/       user and agent sessions, turns, items, summaries, event log, session API
  ai-memory/         memory across sessions: preferences, user, project and agent memory, the
                     memory tool and the memory API's one implementation
  ai-tasks/          the per-project task queue: tasks, subscriptions, leases, dead letters,
                     reply inboxes, the executor contract and its runner (no harness types)
  ai-flue/           Flue on the environment
  ai-host-do/        Durable Objects, REST and RPC, runtime bindings
  ai-openai-compat/  OpenAI projection
  ai-uhp/            UHP projection
  ai-uhp-client/     remote agent sessions over UHP
  ai-conformance/    (private) conformance suite: deployments on CellB (Node, Chromium), CellD and
                     workerd, the scripted model, the threat-table check
```

`ai-access`, `ai-environment`, `ai-definitions`, `ai-sessions`, `ai-flue` and `ai-host-do` are
published (the first usable release, statewalker/statewalker-root#132), and `ai-memory`
(statewalker/statewalker-root#173), which `ai-sessions` and `ai-host-do` depend on, and
`ai-uhp-client` (statewalker/statewalker-root#144), which `ai-host-do` depends on, and
`ai-openai-compat` (statewalker/statewalker-root#138) and `ai-uhp` (statewalker/statewalker-root#139),
which `ai-host-do` routes, and `ai-tasks` (statewalker/statewalker-root#206), which `ai-sessions`
and `ai-host-do` depend on; the others are private
skeletons until their tickets give them content. A package's first version is published once, by a
human, and later releases go through CI (statewalker-root's release rules). In the workspace the
packages export their TypeScript sources; `publishConfig.exports` points the published ones at
`dist/`, built by tsdown.

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

CI also runs the conformance suite on the other three runtimes, each in a job of its own
(statewalker/statewalker-root#85): `pnpm --filter @statewalker/ai-conformance run test:browser`
(CellB in Chromium, Playwright), `test:celld` (`celld dev` in celld's pinned Docker image; set
`CELLD_BIN` to a celld binary to run without Docker) and `test:workerd` (`wrangler dev`, local
workerd). A scenario that needs what only some runtimes offer (the `local` workspace backend,
deployment-held keys) runs where `CAN` in `packages/ai-conformance/src/deployment.ts` says so.

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
- **Memory belongs to its owner** (statewalker/statewalker-root#157, #173). Project and agent
  memory live in each project's system folder (`.system/memory/`), kept by the Workspace DO;
  preferences and user memory in the user's profile, kept by their User DO. The memory service in
  `ai-memory` is their only writer, run in the DO that holds each kind so writes serialize there;
  agents reach it through the memory tool, people through the memory API. Caps come from the
  deployment's `MEMORY_CAPS` and a project's `.system/memory-caps`.
- **Remote agents work on copies** (statewalker/statewalker-root#109, #144). A remote agent session's
  core is an external harness behind a UHP server (`UHP_SERVERS`, a workspace's
  `/.system/uhp-servers`): it gets copies of the files its capability can read, and its artifacts
  return through the capability as one change set under the mode. Only the server's own token (a
  secret bound to its host) crosses; its items are `external`, never shown to the risk classifier.
- **Limits live where their counters do** (statewalker-root#158, #179). A limit
  `{meter, level, target?, value, period, on_exceed, warn_at?, increment?}` is set in the
  deployment's `LIMITS` var (a `deployment` limit is a ceiling each workspace and each user is held
  to), the workspace's `.system/limits` (workspace, project, member and default session limits), a
  project's `.system/limits` (its project and session limits), a user's profile `/limits` (their
  own keys) or a session's start request (`limits`). Each level is counted in the DO that owns it,
  with no global counter; `TIME_ZONE` sets calendar periods and `USAGE_RETENTION_MONTHS` (13) how
  long usage records are kept.
- **Rate limits are limits with short periods** (statewalker-root#158, #180): `period: second` or
  `minute` with `on_exceed: delay`, where a request waits for its window up to `LIMITS_MAX_DELAY_MS`
  (30 s), then is denied. The session API's messages, SSE streams and session starts count as
  `api_requests`, per user in the User DO and per workspace in the Workspace DO (60 and 600 a minute
  by default; a LIMITS entry for the level replaces its default); over the limit it answers `429`
  with `Retry-After`. A deployment provider's `rate {rpm, tpm, share?, shares?}` holds each
  workspace to its share of the key in its own DO; over it a request waits, then falls back to the
  agent's next model like a provider's 429, and with no model left the turn ends incomplete with
  `stop_reason: rate_limited`. A user's own keys are held to their own `user` limits on
  `model_requests` and `model_tokens`.
- **Tasks wait in a queue until someone pulls them** (statewalker/statewalker-root#160, #206). Each
  project has one task queue in its Workspace DO: people, agents (the tools `tasks_publish`,
  `tasks_peek`, `tasks_take`, `tasks_reply`) and, later, webhooks and schedules publish tasks under
  subjects; subscriptions (NATS-style `*` and `>` filters on the subject, a destination, a sender)
  peek, take or claim them with leases, and notifications only say "changed". The contract in
  `ai-tasks` names no harness type, so it can move to a lower layer (#204); rights
  (`tasks.publish`, `tasks.subscribe`, `tasks.admin`), modes and limits are the host's. The
  deployment's `TASKS` (`{max_payload_bytes, expiry_days, max_expiry_days, dead_letter_days,
  max_waiting}`) sets the caps: 64 KB payloads, 7 days (30 at most), 14 days of dead letters and
  10,000 waiting tasks per project; the queue's bytes count as storage (category `queue`).
