# @statewalker/ai-environment

## 0.2.0

### Minor Changes

- Release of the changes since the last published version:
  
  - @statewalker/ai-access crosses a breaking line

### Patch Changes

- Updated dependencies [b550856]
  - @statewalker/ai-access@0.2.0

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
- 24a5708: The model gateway's `local` provider (statewalker/statewalker-root#143): a runtime declares a local
  model engine with `installLocalEngine` (`@statewalker/ai-environment/local-models`), and `local`
  models run on it with no key, only once the user has downloaded their weights; elsewhere they answer
  `ENOSYS` and, like a model without weights, fall back to the agent's next model.
  `@statewalker/ai-environment/webllm` is the WebLLM engine, ported from `ai-local-models.browser`.
  The Workspace DO serves `local` models through the runtime's engine.
- 186eb63: Memory across sessions (statewalker/statewalker-root#173): the new `ai-memory` package, the memory
  tool for agents and the memory API (REST and RPC) for people, priming at session start and after
  compaction, and memory counted against the storage limits.
- 2e3414b: File pre-images and reverting files on rewind (statewalker/statewalker-root#191). The gate keeps,
  owner-side, the pre-image of every file an agent session (or a sub-agent it started) writes,
  deletes or moves, keyed by session and turn (`PreImageLog`, `preImaged` in ai-environment).
  Rewind, edit and regenerate accept `revert_files: true`: each file goes back to its state before
  the first rewound turn, only where nobody changed it since; the result's `files` lists what was
  reverted, the conflicts and the files whose pre-image is gone. The revert is one `write` under the
  mode: in `default` it waits on an approval (`files.approval`), and answering it allowed reverts the
  files then (`answerApproval` answers `files` and no `accepted`; `AgentPort.answerRevert`).
  Pre-images are kept 30 days or 100 MB per top-level session (deployment var `PRE_IMAGES`, workspace
  file `/.system/pre-images`), count toward the files meter, and are dropped with the session or the
  project. A fork's `forked_from` carries the pre-images' `checkpoint` when the gate kept any.
  `RunAction` gets the turn an action runs in.
- eef62fd: Rate limits (statewalker/statewalker-root#180): limits with `period: second | minute` and `on_exceed: delay` make a request wait for its window up to `LIMITS_MAX_DELAY_MS` (30 s), then deny it. New meters `api_requests` and `model_requests`. The session API's messages, SSE streams and session starts are limited per user (User DO) and per workspace (Workspace DO), 60 and 600 a minute by default, answering `429` with `Retry-After` (`UserPort.admitRequest`, `WorkspaceGrants.admitRequest`). A provider's `rate {rpm, tpm, share?, shares?}` holds each workspace to its share of a deployment key; over it a request waits, then falls back like a provider's 429 (`isRateRefusal`); with no model left a turn ends incomplete with `stop_reason: rate_limited`. A user's own keys are held to their own `user` limits on `model_requests` and `model_tokens`. `withDelay` takes a clock and keeps waiting until the max delay; `ModelMeter.admit` receives the provider; ledger charges take `{record: false}`.
- 85dfc29: Appends are one change at the gate (statewalker/statewalker-root#146): the gated view and the
  mode gate take `append`, one at a time per file, decided as a write and asked about as an
  `append` approval (a new `StoredAction` method) that adds exactly its bytes when approved. The
  agent's shell appends through it, so parallel sessions appending to one file lose nothing; it
  stores redirected binary output byte for byte (just-bash's `binary`/`latin1` content is no
  longer encoded as UTF-8), and `cp`/`mv` onto an existing file or into a folder work (the file
  view tells just-bash each entry's identity).
- 66c5454: The task queue (statewalker/statewalker-root#206): the new `ai-tasks` package (tasks, subscriptions
  with NATS-style filters, peek, take and leased claims with dead letters, reply inboxes, the
  `Executor` contract and `serveSubscription`), one queue per project in the Workspace DO, the task
  API over REST and RPC (`/v1/projects/{p}/tasks`, `/v1/projects/{p}/subscriptions`, `/v1/leases/{id}`,
  SSE `changed` notifications), the agent tools `tasks_publish`, `tasks_peek`, `tasks_take` and
  `tasks_reply` (publishing under the mode; `plan` denies it), and the queue counted as storage.
- 483d887: Telemetry without content (statewalker/statewalker-root#182): OpenTelemetry traces (one per turn,
  with spans for model requests, tool calls, executor runs, memory-tool calls and approval waits;
  gate operations sampled), metrics (meter counters, latency histograms, error and denial counts,
  queue waits) and structured logs, carrying ids, sizes, timings and outcomes only through an
  allowlist schema of attributes. `ai-environment` holds the telemetry and its exporters (OTLP over
  `fetch`, a console, or off; a browser deployment gets the console or nothing); `ai-host-do` reads
  the deployment's `TELEMETRY` var.
- 38358cf: The Pyodide code engine (statewalker/statewalker-root#142): `@statewalker/ai-environment/pyodide`
  (`pyodideEngine`, `pyodideNodeHost`, `pyodideWorkerHost`) and its engine script
  `engines/pyodide-engine.mjs`. A runtime's host installs it to run `python` from the agent's `bash`
  tool: on Node in a child process under Node's permission model, in a browser in a module Worker;
  the session's project is copied in and each change written back through the session's file view,
  authorized again; no network.
  
  The Wasmer code engine on Node and in a page (statewalker/statewalker-root#142): `@statewalker/ai-environment/wasmer`
  (`wasmerEngine`, `wasmerWorkerEngine`) and its engine scripts `engines/wasmer-*.mjs`: WASIX programs the deployment lists
  run in a Wasmer sandbox whose `/workspace` is the session's file view, every file operation
  forwarded live to the gate; no network.
- be60a0f: Remote agent sessions over UHP (statewalker/statewalker-root#144): the new `ai-uhp-client` package
  runs an agent session whose core is an external harness behind a UHP server (2026-10-19), started
  as `remote:<server>/<harness>` (or from an agent with `remote: {server, harness}`) with
  `agents.use:remote:<server>/<harness>`, which no built-in role holds. Files under the agent's
  `inputs` are copied in; artifacts are written back as one change set under the mode;
  `input_request` becomes an approval or a question (a `question` item); remote items are
  `external`; cancel, archive and revoke send UHP cancel. Servers are registered in `UHP_SERVERS` or a
  workspace's `/.system/uhp-servers`.
- 77b06f0: A sub-agent's approval surfaces on its root session (statewalker/statewalker-ai#88): a turn whose
  sub-agent (started with `agent.start`) waits on an approval now waits on it too, as a stored `agent`
  action it does not record as its own, so the turn ends `waiting` instead of `completed`. Answering
  the approval (or its expiry) continues the sub-agent, then each waiting turn up to the root with the
  sub-agent's outcome; `answerApproval` reports those turns in `continued` (parent first) and
  `ApprovalView.root` names the asking session's tree root. UHP asks it as the root response's
  `input_request` and answers with the root's continuing turn; the OpenAI projection's
  `mcp_approval_request` and the AI SDK UI stream's tool approval do the same on the root's call.
  Passing the approval over at the root cancels it for the sub-agent too.
- 04f2b73: Usage and limits API (statewalker/statewalker-root#181): `GET /v1/limits/effective`, `GET /v1/usage?level&period&group_by`, `GET/PUT/DELETE /v1/limits/{level}/{target}` and the NDJSON export `GET /v1/usage/records?since` (the workspace admin's, and every workspace's with the operator token `OPERATOR_KEY`), over REST and RPC. Turns and sessions carry their model usage totals. Usage under a user's own key is shown with its amounts to that user alone. `LimitLedger` gains `states`, `aggregate` and `recordsFrom`; `groupUsage` groups usage rows. The test-only `/admin/workspaces/<ws>/usage-records` and `/admin/users/<u>/usage-records` routes are removed.

### Patch Changes

- 7343fd2: The gate's files-RPC server answers every chunk of a stream cut by a revocation with the refusal (`EACCES`), also chunks already waiting at the server or whose check passed only after another chunk's refusal; before, such a chunk failed as `UNKNOWN_STREAM: the stream was closed` (statewalker/statewalker-ai#75).
- a2a5575: The OpenAI projection (statewalker/statewalker-root#138): the new `ai-openai-compat` package
  serves `responses`, `conversations`, `chat/completions` and `models` at each agent's base URL
  `/v1/projects/<project>/agents/<agent>/`, so existing OpenAI clients drive harness agents; the
  Worker routes it, and `openAiFetch` runs it in the client over the session API's RPC methods. A
  message may name the turn it chains on (`after_turn`): an earlier turn moves the head there first,
  an implicit rewind that reverts no file, recorded by the item "head moved: chained on an earlier
  response". Concurrent changes the mode asks about in one turn each name their own approval.
- Updated dependencies [288a9b1]
- Updated dependencies [b00497e]
- Updated dependencies [870800b]
- Updated dependencies [186eb63]
- Updated dependencies [66c5454]
- Updated dependencies [0a262dc]
- Updated dependencies [be60a0f]
  - @statewalker/ai-access@0.1.0
