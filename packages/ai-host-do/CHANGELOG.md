# @statewalker/ai-host-do

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
- 0a262dc: Triggers (statewalker/statewalker-root#207): schedules (cron in an IANA time zone or `at`, at most
  every 15 minutes, missed fires recorded and the latest within an hour run once), webhooks
  (`POST /v1/hooks/{id}`, HMAC over timestamp and body with replays refused, or the owner service
  account's token; `Idempotency-Key`) and manual fires (`POST /v1/triggers/{id}/fire`), as consumers
  of the project's task queue. Each fire runs an unattended turn as the trigger's owner, in the
  trigger's mode, in a new session (archived after 30 days) or one of the owner's sessions;
  `max_concurrent`, history, suspension on lost access, and the trigger API
  (`/v1/projects/{p}/triggers`) over REST and RPC. ai-access: the `E2BIG` error (413) and a session
  mode fixed in an agent session's capability.
- ed8a2ad: Native tool scripts in isolates (statewalker/statewalker-root#130): the plugin builder bundles a
  plugin's tool scripts with webrun-bundler (one ESM bundle per tool, named by sha-256), generates the
  OpenAPI document of OpenCode-style tools and holds workspace and project plugins to the acceptance
  check; the deployment runs each call in a Worker Loader isolate of its own (`LOADER`), with the
  network off, files and databases only through the tool's capability, isolate time metered as
  `executor_cpu_ms:isolate`, catalog bundles only once approved by hash (`APPROVED_BUNDLES`).
- a2a5575: The OpenAI projection (statewalker/statewalker-root#138): the new `ai-openai-compat` package
  serves `responses`, `conversations`, `chat/completions` and `models` at each agent's base URL
  `/v1/projects/<project>/agents/<agent>/`, so existing OpenAI clients drive harness agents; the
  Worker routes it, and `openAiFetch` runs it in the client over the session API's RPC methods. A
  message may name the turn it chains on (`after_turn`): an earlier turn moves the head there first,
  an implicit rewind that reverts no file, recorded by the item "head moved: chained on an earlier
  response". Concurrent changes the mode asks about in one turn each name their own approval.
- be60a0f: Remote agent sessions over UHP (statewalker/statewalker-root#144): the new `ai-uhp-client` package
  runs an agent session whose core is an external harness behind a UHP server (2026-10-19), started
  as `remote:<server>/<harness>` (or from an agent with `remote: {server, harness}`) with
  `agents.use:remote:<server>/<harness>`, which no built-in role holds. Files under the agent's
  `inputs` are copied in; artifacts are written back as one change set under the mode;
  `input_request` becomes an approval or a question (a `question` item); remote items are
  `external`; cancel, archive and revoke send UHP cancel. Servers are registered in `UHP_SERVERS` or a
  workspace's `/.system/uhp-servers`.
- f3c84bf: Remote MCP servers (statewalker/statewalker-root#135): a plugin's `mcp.json` Streamable HTTP
  servers are listed by the Workspace DO's MCP gateway (stateless MCP 2026-07-28, through the
  secrets gateway) and their tools join the session's tool set as `<plugin>__<tool>`, re-checked at
  every call. stdio and SSE servers answer ENOSYS; credentials come only from bound secrets
  (`${NAME}` or `{{secret:NAME}}`), and a server whose files hold one is refused. A tool reads only
  where the plugin says so (`x-dev.cellb.harness: {actions}`). ai-definitions adds
  `catalogMcpServers`, `mcpServersOf`, `mcpTools`, `mcpRequest`, `mcpAnswer`, `mcpCallOutput` and
  `MCP_REVISION`; the MCP tool route gains `server` and `headers`; `NarrowedAgent.mcpTools` keeps an
  agent's tool patterns for tools listed later.
- 5fa0aa7: Session search and the session table of contents (statewalker/statewalker-root#174): during compaction the summarizer writes each session's topics (an append-only `topics` table, merged with superseding rows, refs to leaf items, following the active path); `GET /v1/sessions/{id}/topics` (`?branch=`, `?all=true`) and the RPC method `listTopics` serve them; the session index keeps each session's topic titles; the harness tool `session_search` scans the user's own sessions in the project (sub-agents' included), topics first and items as fallback, fenced as data, behind the `SessionSearch` interface.
  
  Memory's `search` action and `session_search` share one regular-expression guard (`searchRegExp`): a repeated group holding a repetition or an alternation is refused.
- a7f6bd8: The turn tree (statewalker/statewalker-root#190): an agent session's turns record `parent_turn`
  and `origin`, the session has a movable head and the context is the root-to-head path. New session
  API methods (RPC and REST, owner only): rewind (`POST /v1/sessions/{id}/rewind`), branch switch
  (`PUT /v1/sessions/{id}/head`), edit and regenerate (`POST /v1/turns/{id}/edit|regenerate`), the
  tree (`GET /v1/sessions/{id}/branches`), erasing an inactive branch
  (`DELETE /v1/sessions/{id}/branches/{turn}`) and fork (`POST /v1/sessions/{id}/fork`). Items list
  the active path by default (`?branch=`, `?all=true`). Agent DO storage is migrated in place.
- 04f2f47: The UHP projection (statewalker/statewalker-root#139): the new `ai-uhp` package serves UHP class
  Core plus `input_requests`, pinned to UHP `2026-10-19`, under `/uhp`; each agent the user may start
  is a harness `<project>/<plugin>/<agent>`, a UHP session is an agent session and a response a turn,
  approvals go out one `input_request` at a time with scope "once", `branch: true` forks and
  `previous_response_id` on an earlier response moves the head. The session API lists the agents the
  caller may start (`listAgents`, `GET /v1/agents`), and a message may pass over the approvals the
  session waits on (`void_approvals`, reported in `voided_approvals`). `ai-openai-compat` exports its
  Responses event encoder (`EventEncoder`) and SSE helper (`sseResponse`) for reuse.
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

- c1c6ced: The harness runs on CellD and workerd as on CellB (statewalker/statewalker-root#141):
  - **File writes on CellD:** a file write streamed over several files-RPC calls keeps the call that opened it alive until the stream ends, in the Workspace and Profiles DOs. CellD refuses a storage transaction to code continuing an event that has ended.
  - **Native tools on CellD:** a native tool's isolate reaches the host by plain values, one step per round of host calls, where the Worker Loader carries no stub into it (CellD). Elsewhere it still gets the host as a stub.
  - **Remote agent turns on CellD:** a remote agent session's turn keeps its event alive while it runs (`ctx.waitUntil`), as Flue's turns do. CellD drops the timers and continuations of an event that has ended, which left the turn's polls waiting forever.
  - **`local` workspace backend:** documented as CellB Node only, since CellD's `node:fs` has no host file system.
  - **Native tool transport choice:** the transport is probed once per isolate, with a loaded worker that holds no tool code, and never inferred from a tool's own run.
- 24a5708: The model gateway's `local` provider (statewalker/statewalker-root#143): a runtime declares a local
  model engine with `installLocalEngine` (`@statewalker/ai-environment/local-models`), and `local`
  models run on it with no key, only once the user has downloaded their weights; elsewhere they answer
  `ENOSYS` and, like a model without weights, fall back to the agent's next model.
  `@statewalker/ai-environment/webllm` is the WebLLM engine, ported from `ai-local-models.browser`.
  The Workspace DO serves `local` models through the runtime's engine.
- a0b7f2e: Remote agent sessions follow the turn tree (statewalker/statewalker-ai#84): `TurnRun.path` gives a
  core the turn's active path, and a remote session's next task continues from the remote response on
  it (`previous_response_id`), so a rewind, a branch switch or an edit moves the remote session too; a
  fork, or a rewind before the first task, starts a fresh remote session with the files copied in
  again. A revoke or an archive that lands while a task's first POST is out now sends UHP cancel: the
  Workspace DO checks the answer against the capability's revocation ids.
  
  A turn resumed after a restart no longer becomes its own parent in the turn tree (its path looped).
- Updated dependencies [288a9b1]
- Updated dependencies [b00497e]
- Updated dependencies [870800b]
- Updated dependencies [fa0b869]
- Updated dependencies [7343fd2]
- Updated dependencies [24a5708]
- Updated dependencies [186eb63]
- Updated dependencies [2e3414b]
- Updated dependencies [eef62fd]
- Updated dependencies [85dfc29]
- Updated dependencies [66c5454]
- Updated dependencies [483d887]
- Updated dependencies [0a262dc]
- Updated dependencies [ed8a2ad]
- Updated dependencies [a2a5575]
- Updated dependencies [38358cf]
- Updated dependencies [be60a0f]
- Updated dependencies [f3c84bf]
- Updated dependencies [a0b7f2e]
- Updated dependencies [5fa0aa7]
- Updated dependencies [a7f6bd8]
- Updated dependencies [04f2f47]
- Updated dependencies [77b06f0]
- Updated dependencies [04f2b73]
  - @statewalker/ai-access@0.1.0
  - @statewalker/ai-environment@0.1.0
  - @statewalker/ai-definitions@0.1.0
  - @statewalker/ai-sessions@0.1.0
  - @statewalker/ai-flue@0.1.0
  - @statewalker/ai-openai-compat@0.1.0
  - @statewalker/ai-memory@0.1.0
  - @statewalker/ai-tasks@0.1.0
  - @statewalker/ai-uhp-client@0.1.0
  - @statewalker/ai-uhp@0.1.0
