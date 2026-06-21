# @statewalker/ai-agent

A TypeScript library for building multi-turn AI agents with persistent state, tool/skill registries, MCP integration, and session management. Built on the [Vercel AI SDK](https://sdk.vercel.ai/).

The package is framework-free (no workspace / shared-adapters dependencies) — it deals only with the agent loop, state tree, tools, models, and persistence. Application-level concerns (UI, commands, fragment activators) live in the workbench fragments (`@statewalker/ai-agent-runtime`, `@statewalker/ai-config`, `@statewalker/models-config`) and the consuming apps.

## Three-tier API

```
AgentRuntime   ─→   Agent (definition)   ─→   Session (runtime instance)
```

- **`AgentRuntime`** — project-level entry point. Owns providers, tools, skills, the FilesApi split (system view vs tools view), MCP clients, session storage. Built once; stays alive for the life of the host.
- **`Agent`** — a *definition*: name, tools whitelist, skills whitelist, system prompt, default model, optional sub-agents. Cheap to construct; agents are loaded from `<systemPath>/agents/*.md` at `build()` time and can also be created programmatically.
- **`Session`** — a *runtime instance* bound to one Agent. Owns the conversation tree, inbox, per-session tool/skill views, and the loop. Persisted by id under `<systemPath>/sessions/`.

Each Session owns one **`ContextWindow`** — the module that, given the current conversation tree and active skills, produces `{ system, messages }` for the next model call. It orchestrates compaction, selection, elision, pin policy, and system-prompt assembly behind one interface, so the agent loop's per-turn code is `build → streamText → process`. Configured runtime-wide via `setSelectionStrategy` / `setBudgetCompaction`; per-agent overrides flow through the agent's `selectionStrategy` and `systemPrompt`.

## Sub-path exports

| Export Path | Description |
|---|---|
| `@statewalker/ai-agent/runtime` | `AgentRuntime`, `Agent`, `Session`, runtime types and FilesApi helpers (`buildToolsView`, `hideUnder`, `insideSubtree`). The official entry point. |
| `@statewalker/ai-agent/state` | `TreeNode`, `SessionState`, `Turn`, `TurnGroup`, `Message`, `ToolCall`, `Inbox`, `ToolRegistry`, `SkillsModel`, `NodeType`, `LogMessage`, `createAgentNodeFactory`, tree types. Explicit per-symbol exports; serialization helpers live at `/state/serialization` and `/state/session-serialization` (deep import) — they are not part of the published surface. |
| `@statewalker/ai-agent/models` | `ModelManager`, `LocalModelStorage`, model catalog, remote discovery, `verifyModelAccess`, provider/model types. `ModelStateStore` implements `ProviderV3` directly; use `ModelManager#provider` to pass it to `addModelProvider()`. |
| `@statewalker/ai-agent/tools` | File-system tools (`createFileTools`) and path utilities. |

The bare `@statewalker/ai-agent` root is intentionally empty — go through one of the sub-paths above. Internal modules (`context`, `mcp`, `skills`, `config`, `sessions`) are no longer reachable; they're implementation detail. The `Session` deprecated alias previously re-exported from `/state` was removed; use `SessionState` directly.

## Quick start

```ts
import { AgentRuntime } from "@statewalker/ai-agent/runtime";
import { createFileTools } from "@statewalker/ai-agent/tools";
import { NodeFilesApi } from "@statewalker/webrun-files-node";
import { createAnthropic } from "@ai-sdk/anthropic";

const files = new NodeFilesApi({ rootDir: "/my/project" });

const runtime = await new AgentRuntime({ files })
  .addModelProvider(createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY }))
  .setSystemPath(".settings/")
  .addTools((ctx) => createFileTools(ctx.files))
  .build();

const assistant = runtime.createAgent({
  name: "assistant",
  defaultModel: "claude-sonnet-4-20250514",
  systemPrompt: "You are a helpful assistant.",
});

const session = assistant.createSession({ title: "first chat" });
session.send("List the markdown files in /docs.");

for await (const log of session.run()) {
  console.log(log.kind, log.content);
}

const id = await session.save();
// later: const resumed = await runtime.loadSession(id);
```

## FilesApi split (system vs tools views)

`AgentRuntime` builds two views over the root `FilesApi` you pass to its constructor:

- **System view** — full visibility. Used internally by the runtime for agent definition loading, skill loading, and session persistence. Never exposed to tools.
- **Tools view** — a `FilteredFilesApi` over the same root with the system path-tree hidden. Tools and skills receive this via `AgentContext.files`. Hidden paths are reported as not-existing (read/list/stats/exists return empty/false); writes/mkdir into hidden paths reject with `"Path is hidden"`.

Default: `setSystemPath("/.settings/")`. The system path-tree is laid out:

| Subject | Path on `systemFiles` |
|---|---|
| Agents folder | `/agents/` |
| Skills folder | `/skills/` |
| Sessions folder | `/sessions/` |
| Config folder | `/` |

`AgentContext` is `{ files: FilesApi }` — tools and skills receive the tools view only. Tool factories needing more (model, provider, custom storage) accept those as closure-captured constructor arguments at their own factory boundary.

## Error handling

A single error handler routes errors from every runtime-internal source, supplied via the constructor:

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

Default handler is `console.warn`. Errors thrown by build-phase configuration mistakes (no provider, system path covering root, etc.) are routed through the handler **and** rethrown — observers see the error and `await runtime.build()` still rejects.

## API surface

### `class AgentRuntime`

#### Constructor

```ts
new AgentRuntime({ files: FilesApi, errorHandler?: AgentRuntimeErrorHandler })
```

#### Fluent setup (each returns `this`)

| Method | Purpose |
|---|---|
| `setSystemPath(path)` | System path-tree root. Default `"/.settings"`. |
| `addModelProvider(...providers)` | Register one or more `ProviderV3` instances. Callers holding a `ModelManager` pass `modelManager.provider`. |
| `addTools(...tools)` | Register tools (`ToolSet` or `ToolFactory`). |
| `addSkills(...skills)` | Register skills programmatically. |
| `setMcpServers(config)` | Configure MCP servers inline. |

Per-subject paths under `<systemPath>` are hard-coded: `sessions` → `/sessions`, `skills` → `/skills`, `agents` → `/agents`, `config` → `/`. The tools view always uses `FilteredFilesApi` with the system path-tree hidden. To customise context-window behaviour (selection strategy, budget compaction, summariser, etc.), construct a `ContextWindow` directly and pass it to a `Session` — the runtime no longer carries that surface. The error handler is set via the constructor option `errorHandler` rather than a live setter.

#### Materialization

- `build(): Promise<this>` — load skills + agent definitions from disk, resolve the provider union, connect MCP. Idempotent.

#### Agent definitions

- `createAgent(def: AgentDefinition): Agent`
- `getAgent(name): Agent | undefined`
- `agents(): Agent[]`

#### Sessions

- `loadSession(id): Promise<Session>`
- `listSessions(): Promise<SessionMetadata[]>`
- `deleteSession(id): Promise<boolean>`

#### Read-only views

- `files: FilesApi` (tools view)
- `systemFiles: FilesApi` (system view)
- `config`, `mcp`

### `class Agent`

A definition value. Use `runtime.createAgent({ ... })` rather than constructing directly.

```ts
interface AgentDefinition {
  name: string;
  tools?: string[];        // empty / undefined → all
  skills?: string[];       // empty / undefined → none
  systemPrompt?: string;
  defaultModel?: string;
  maxSteps?: number;
  maxOutputTokens?: number;
}
```

- `createSession({ title?, sessionId? }): Session`

### `class Session`

A runtime instance.

- `id: string`, `agent: Agent`, `state: SessionTreeNode`
- `inbox`, `tools`, `skills` — per-session views
- `send(text, opts?)` — push a user message into the inbox
- `run(signal?): AsyncGenerator<LogMessage>` — drive the loop
- `save({ title? }): Promise<string>` — persist
- `close(): Promise<void>` — tear down

## Migration from `AgentBuilder` (removed)

The legacy `AgentBuilder` / `AgentManager` / `Agent` (wrapper) / `SubAgentTool` classes were removed. The mapping:

| Legacy | New |
|---|---|
| `new AgentBuilder().withProvider(p).withFilesApi(f).withTools(t).build()` | `await new AgentRuntime({ files: f }).addModelProvider(p).addTools(t).build()` |
| `withProvider(p)` / `withModelManager(m)` | `addModelProvider(p)` / `addModelProvider(m.provider)` |
| `withModel(model)` | per-Agent: `runtime.createAgent({ defaultModel: model })` |
| `withFilesApi(f)` | constructor option |
| `withSystemFolder(path)` | `setSystemPath(path)` |
| `withExcludedPaths(...)` | pre-wrap the `FilesApi` with `FilteredFilesApi` before passing it in |
| `withTools(t)` | `addTools(t)` |
| `withSkills(s)` / `withSkillsFolder(path)` | `addSkills(...s)` + `setSkillsPath(path)` |
| `withMcpServers(cfg)` / `withMcpConfigFile(path)` | `setMcpServers(cfg)` / `setMcpConfigFile(path)` |
| `new AgentManager(builder).create(title)` | `runtime.createAgent({ name }).createSession({ title })` |
| `manager.resume(id)` | `runtime.loadSession(id)` |
| `agent.run(signal)` | `session.run(signal)` |
| `agent.inbox.push({ role: "user", text })` | `session.send(text)` |
| `agent.save(title)` | `session.save({ title })` |
| `withSubAgent(name, factory)` | `agentDef.addSubAgent(other)` *(runtime support pending)* |

The `SessionManager` interface and `Agent` wrapper class no longer exist — sessions are returned directly from `agent.createSession()` / `runtime.loadSession()`.

## Skill markdown format

Skills are markdown files under `<systemPath>/skills/` with key=value frontmatter:

```
---
name=analyze-csv
description=Read a CSV and produce a summary statistics report.
---

(skill body — instructions for the LLM when this skill is selected)
```

`name` and `description` are required. Additional keys are passed through as metadata.

## License

MIT.
