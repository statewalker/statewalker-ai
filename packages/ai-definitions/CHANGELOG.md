# @statewalker/ai-definitions

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
- ed8a2ad: Native tool scripts in isolates (statewalker/statewalker-root#130): the plugin builder bundles a
  plugin's tool scripts with webrun-bundler (one ESM bundle per tool, named by sha-256), generates the
  OpenAPI document of OpenCode-style tools and holds workspace and project plugins to the acceptance
  check; the deployment runs each call in a Worker Loader isolate of its own (`LOADER`), with the
  network off, files and databases only through the tool's capability, isolate time metered as
  `executor_cpu_ms:isolate`, catalog bundles only once approved by hash (`APPROVED_BUNDLES`).
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

### Patch Changes

- Updated dependencies [288a9b1]
- Updated dependencies [b00497e]
- Updated dependencies [870800b]
- Updated dependencies [186eb63]
- Updated dependencies [66c5454]
- Updated dependencies [0a262dc]
- Updated dependencies [be60a0f]
  - @statewalker/ai-access@0.1.0
