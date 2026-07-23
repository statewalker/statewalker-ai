# Architecture

## Three-tier model

```
AgentRuntime   ─→   Agent (definition)   ─→   Session (runtime instance)
```

| Tier | Role | Lifetime | Key source |
|---|---|---|---|
| **AgentRuntime** | Project-level entry point. Owns providers, tools, skills, FilesApi split, MCP, session storage. | Built once, alive for host process. | `src/runtime/agent-runtime.ts` |
| **Agent** | A definition: name, tools whitelist, skills whitelist, system prompt, default model, executor. | Cheap to construct; multiple sessions per agent. | `src/runtime/agent.ts` |
| **Session** | Runtime instance bound to one Agent. Owns conversation tree, inbox, per-session tool/skill views, loop. | Created per conversation; persisted by id. | `src/runtime/session.ts` |

### Construction flow

1. `new AgentRuntime({ files, errorHandler? })` — takes a root `FilesApi` and optional error handler.
2. Fluent setup (each returns `this`): `.setSystemPath(path)`, `.addModelProvider(...)`, `.addTools(...)`, `.addSkills(...)`, `.setMcpServers(config)`.
3. `await runtime.build()` — materialises: builds FilesApi split, resolves provider, loads skills + agent definitions from disk, connects MCP. Idempotent after first call.
4. `runtime.createAgent(def)` — registers an Agent definition.
5. `agent.createSession({ title?, sessionId?, existingState? })` — spawns a Session with per-session inbox, tool registry, skills model, turn driver, executor.

> **Source**: `src/runtime/agent-runtime.ts` (class `AgentRuntime`), `src/runtime/agent.ts` (class `Agent`), `src/runtime/session.ts` (class `Session`).

## Module map

```
src/
├── index.ts                  # root — intentionally empty (use sub-paths)
├── config/                   # ConfigManager — JSON config load/save over FilesApi
├── context/                   # Context shaping: ContextWindow, compaction, selection, elision, pin policy
├── mcp/                       # MCP integration: McpClientManager, bridgeMcpTools
├── models/                    # Model lifecycle: ModelManager, ModelStateStore, LocalModelStorage
├── runtime/                   # Agent loop: AgentRuntime, Agent, Session, Executor, TurnDriver, gates
│   └── fsm/                   # FSM-based executor: FsmExecutor, process-config, log-channel
├── sessions/                  # Session persistence: FilesSessionManager, metadata
├── skills/                    # Skill parsing: parseSkillMarkdown, SkillInfo
├── state/                     # Conversation state tree: SessionState, Turn, TurnGroup, Inbox, ToolRegistry
│   └── serialization/         # Tree serialization: markdown round-trip, flat stream, JSON
└── tools/                     # Tool implementations
    └── file-tools/            # 15 built-in file-operation tools
```

### Internal vs public surface

The root export (`@statewalker/ai-agent`) is intentionally empty. Internal modules (`config`, `context`, `mcp`, `sessions`, `skills`) are implementation detail — not reachable from the published sub-paths. They are imported via deep paths by the runtime internally. The four sub-paths (`/runtime`, `/state`, `/models`, `/tools`) are the public surface.

**Source**: `src/index.ts` (comment explaining the intent), `src/runtime/index.ts`, `src/state/index.ts`, `src/models/index.ts`, `src/tools/index.ts`.

## FilesApi split

`AgentRuntime.build()` creates two views over the root `FilesApi`:

| View | Visibility | Used by | Implementation |
|---|---|---|---|
| **System view** | Full visibility, rooted at `systemPath`. | Runtime internals: config loading, skill/agent loading, session persistence. | `CompositeFilesApi(rootFiles, systemPath)` |
| **Tools view** | System path-tree hidden. | Tools and skills (via `AgentContext.files`). | `FilteredFilesApi(rootFiles, hideUnder(systemPath))` |

Hidden paths report as not-existing (read/list/stats/exists return empty/false); writes/mkdir into hidden paths reject with `"Path is hidden"`.

Default `systemPath`: `"/.settings"`. System-relative paths under it:

| Subject | Path on `systemFiles` |
|---|---|
| Agents folder | `/agents/` |
| Skills folder | `/skills/` |
| Sessions folder | `/sessions/` |
| Config folder | `/` |

`buildFilesSplit` throws when `systemPath === "/"` (hiding root would make every path invisible to tools).

**Source**: `src/runtime/files-split.ts` (`buildFilesSplit`, `hideUnder`, `normalizeFolderPath`).

## Error handling

A single `AgentRuntimeErrorHandler` routes errors from every runtime-internal source:

```ts
const runtime = new AgentRuntime({
  files,
  errorHandler: (err, ctx) => {
    // ctx?.path   — set when a FilteredFilesApi violation surfaces
    // ctx?.server — set when an MCP server interaction fails
    log.warn({ err, ctx });
  },
});
```

- Default handler: `console.warn`.
- Build-phase config errors (no provider, system path covering root) are routed through the handler **and** rethrown — `await runtime.build()` rejects.
- Per-file errors during agent/skill disk loading flow through the handler without aborting the walk.
- MCP errors flow through the handler with `ctx.server` set.

**Source**: `src/runtime/types.ts` (`AgentRuntimeErrorHandler`, `AgentRuntimeErrorContext`), `src/runtime/agent-runtime.ts` (default handler, routing sites).

## Disk loading

### Agent definitions

`AgentRuntime.build()` walks `<systemPath>/agents/*.md` via `_loadAgentsFromDisk` and registers each file as an `Agent` definition. Programmatically-registered agents (via `createAgent`) win over disk-loaded ones — already-present names are skipped. Per-file errors flow through the error handler.

Agent markdown format: YAML frontmatter (`name`, `description`) + body. The `description` frontmatter becomes `systemPrompt`; the body is the full prompt content. Parsed by `parseAgentMarkdown` (module-private in `agent-runtime.ts`), which delegates to `parseSkillMarkdown`.

### Skills

`AgentRuntime.build()` walks `<systemPath>/skills/*.md` via `_loadSkillsFromDisk`. Manually-registered skills (via `addSkills(...)`) come first; disk-loaded skills append. Returns the manual list unchanged when the folder doesn't exist.

**Source**: `src/runtime/agent-runtime.ts` (`_loadAgentsFromDisk`, `_loadSkillsFromDisk`), `src/skills/skill-parser.ts` (`parseSkillMarkdown`).

## Executor pluggability

Each `Agent` can declare an `Executor` — the loop that drives turns. The default is a shared, stateless `LoopExecutor`. An `FsmExecutor` is also available for formalised FSM-driven processes.

The `Executor` interface owns only across-turn control flow. The per-turn lifecycle (open Turn, build context, `streamText`, route stream parts, close Turn) stays inside `TurnDriver`, reached via `ExecutorContext.drive()`.

See [Agent Loop](agent-loop.md) for full details.

## Why this package lives in workbench as `.core`

Per [ADR 0001](../docs/adr/0001-ai-agent-stays-in-workbench.md): `ai-agent` is a standalone, workspace-free library (deps are only external substrate — `shared-*`, `webrun-*`). A reader might expect it to live in `statewalker-shared` or its own repo. It is deliberately kept **in the workbench** and named `@statewalker/ai-agent.core`, consistent with `backbone.core`.

**Tripwire**: if a consumer outside `statewalker-workbench` + `statewalker-apps` begins importing it, the ADR should be reopened and the package relocated to a dedicated library repo.
