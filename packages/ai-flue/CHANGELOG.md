# @statewalker/ai-flue

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
- eef62fd: Rate limits (statewalker/statewalker-root#180): limits with `period: second | minute` and `on_exceed: delay` make a request wait for its window up to `LIMITS_MAX_DELAY_MS` (30 s), then deny it. New meters `api_requests` and `model_requests`. The session API's messages, SSE streams and session starts are limited per user (User DO) and per workspace (Workspace DO), 60 and 600 a minute by default, answering `429` with `Retry-After` (`UserPort.admitRequest`, `WorkspaceGrants.admitRequest`). A provider's `rate {rpm, tpm, share?, shares?}` holds each workspace to its share of a deployment key; over it a request waits, then falls back like a provider's 429 (`isRateRefusal`); with no model left a turn ends incomplete with `stop_reason: rate_limited`. A user's own keys are held to their own `user` limits on `model_requests` and `model_tokens`. `withDelay` takes a clock and keeps waiting until the max delay; `ModelMeter.admit` receives the provider; ledger charges take `{record: false}`.
- 483d887: Telemetry without content (statewalker/statewalker-root#182): OpenTelemetry traces (one per turn,
  with spans for model requests, tool calls, executor runs, memory-tool calls and approval waits;
  gate operations sampled), metrics (meter counters, latency histograms, error and denial counts,
  queue waits) and structured logs, carrying ids, sizes, timings and outcomes only through an
  allowlist schema of attributes. `ai-environment` holds the telemetry and its exporters (OTLP over
  `fetch`, a console, or off; a browser deployment gets the console or nothing); `ai-host-do` reads
  the deployment's `TELEMETRY` var.

### Patch Changes

- 85dfc29: Appends are one change at the gate (statewalker/statewalker-root#146): the gated view and the
  mode gate take `append`, one at a time per file, decided as a write and asked about as an
  `append` approval (a new `StoredAction` method) that adds exactly its bytes when approved. The
  agent's shell appends through it, so parallel sessions appending to one file lose nothing; it
  stores redirected binary output byte for byte (just-bash's `binary`/`latin1` content is no
  longer encoded as UTF-8), and `cp`/`mv` onto an existing file or into a folder work (the file
  view tells just-bash each entry's identity).
- a7f6bd8: The turn tree (statewalker/statewalker-root#190): an agent session's turns record `parent_turn`
  and `origin`, the session has a movable head and the context is the root-to-head path. New session
  API methods (RPC and REST, owner only): rewind (`POST /v1/sessions/{id}/rewind`), branch switch
  (`PUT /v1/sessions/{id}/head`), edit and regenerate (`POST /v1/turns/{id}/edit|regenerate`), the
  tree (`GET /v1/sessions/{id}/branches`), erasing an inactive branch
  (`DELETE /v1/sessions/{id}/branches/{turn}`) and fork (`POST /v1/sessions/{id}/fork`). Items list
  the active path by default (`?branch=`, `?all=true`). Agent DO storage is migrated in place.
- Updated dependencies [288a9b1]
- Updated dependencies [b00497e]
- Updated dependencies [870800b]
- Updated dependencies [7343fd2]
- Updated dependencies [24a5708]
- Updated dependencies [186eb63]
- Updated dependencies [2e3414b]
- Updated dependencies [eef62fd]
- Updated dependencies [85dfc29]
- Updated dependencies [66c5454]
- Updated dependencies [483d887]
- Updated dependencies [0a262dc]
- Updated dependencies [a2a5575]
- Updated dependencies [38358cf]
- Updated dependencies [be60a0f]
- Updated dependencies [a0b7f2e]
- Updated dependencies [5fa0aa7]
- Updated dependencies [a7f6bd8]
- Updated dependencies [04f2f47]
- Updated dependencies [77b06f0]
- Updated dependencies [04f2b73]
  - @statewalker/ai-environment@0.1.0
  - @statewalker/ai-sessions@0.1.0
