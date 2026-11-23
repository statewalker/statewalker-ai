# @statewalker/ai-access

## 0.1.0

### Minor Changes

- 288a9b1: Code execution (statewalker/statewalker-root#142): the agent's `bash` tool routes `node`, `python` and
  the deployment's WASIX programs to an executor (`EXECUTORS`). `node` scripts are bundled from the
  session's files, held to the acceptance check and run in a Worker Loader isolate with no network;
  `python` and POSIX programs run on a code engine the runtime's host installs
  (`@statewalker/ai-environment/code-engines`), ENOSYS elsewhere. Running code is the `code.run:<kind>`
  action (roles, mode, approvals naming the exact run); an agent's `requires` is checked at session
  start; each run's time is charged as `executor_cpu_ms:<kind>` to the session, member, project and
  workspace, and the run is killed when a limit refuses more. The external executor pool is an
  interface (`ExecutorPool`).
- b00497e: The egress gateway (statewalker/statewalker-root#208): executed code's only network. A node
  script's `fetch`, Pyodide's `pyfetch` (scripts may use top-level `await`), the shell's `curl` and
  `wget`, and a native tool's `ctx.fetch` go through one host-side gateway in the Workspace DO, which
  sends a request only where the deployment allowlist (`EGRESS_ALLOW`, empty by default), the user's
  `net.read`/`net.write` roles, the agent's or tool's `requires.network` and the mode all allow it
  (`acceptEdits` allows reads, `plan` denies the network, `default` asks on first use). HTTPS on the
  default port only; internal and metadata addresses refused (the gateway resolves names itself),
  every redirect re-checked, bound secrets put in only for their hosts, caps on request bodies, query
  strings and answers, each request counted toward `outbound_requests` and recorded as a
  `network_request` item. REST tools and remote MCP servers get the same address rule. Pyodide's raw
  sockets stay closed.
  
  `ai-environment`: `egressFetch`, `parseEgress`, `internalAddress`, `networkNeeds`, transports
  (`nodeTransport`, `fetchTransport`, `dohResolver`); `gatewayFetch` takes an optional address guard;
  `EngineRun.fetch`; `PoolMount.egress`. `ai-access`: the built-in modes decide `net.*`. `ai-sessions`:
  the `network_request` item kind. `ai-flue`: `CodePort.fetch`. `ai-definitions`: a native tool's route
  carries its operation's `requires`.
- 870800b: The harness's first usable release (statewalker/statewalker-root#132): access, the environment,
  definitions, sessions, Flue and the deployment, on CellB (browser and Node), with one
  deployment-level provider configured through `MODELS`.
- 186eb63: Memory across sessions (statewalker/statewalker-root#173): the new `ai-memory` package, the memory
  tool for agents and the memory API (REST and RPC) for people, priming at session start and after
  compaction, and memory counted against the storage limits.
- 66c5454: The task queue (statewalker/statewalker-root#206): the new `ai-tasks` package (tasks, subscriptions
  with NATS-style filters, peek, take and leased claims with dead letters, reply inboxes, the
  `Executor` contract and `serveSubscription`), one queue per project in the Workspace DO, the task
  API over REST and RPC (`/v1/projects/{p}/tasks`, `/v1/projects/{p}/subscriptions`, `/v1/leases/{id}`,
  SSE `changed` notifications), the agent tools `tasks_publish`, `tasks_peek`, `tasks_take` and
  `tasks_reply` (publishing under the mode; `plan` denies it), and the queue counted as storage.
- 0a262dc: Triggers (statewalker/statewalker-root#207): schedules (cron in an IANA time zone or `at`, at most
  every 15 minutes, missed fires recorded and the latest within an hour run once), webhooks
  (`POST /v1/hooks/{id}`, HMAC over timestamp and body with replays refused, or the owner service
  account's token; `Idempotency-Key`) and manual fires (`POST /v1/triggers/{id}/fire`), as consumers
  of the project's task queue. Each fire runs an unattended turn as the trigger's owner, in the
  trigger's mode, in a new session (archived after 30 days) or one of the owner's sessions;
  `max_concurrent`, history, suspension on lost access, and the trigger API
  (`/v1/projects/{p}/triggers`) over REST and RPC. ai-access: the `E2BIG` error (413) and a session
  mode fixed in an agent session's capability.
- be60a0f: Remote agent sessions over UHP (statewalker/statewalker-root#144): the new `ai-uhp-client` package
  runs an agent session whose core is an external harness behind a UHP server (2026-10-19), started
  as `remote:<server>/<harness>` (or from an agent with `remote: {server, harness}`) with
  `agents.use:remote:<server>/<harness>`, which no built-in role holds. Files under the agent's
  `inputs` are copied in; artifacts are written back as one change set under the mode;
  `input_request` becomes an approval or a question (a `question` item); remote items are
  `external`; cancel, archive and revoke send UHP cancel. Servers are registered in `UHP_SERVERS` or a
  workspace's `/.system/uhp-servers`.
