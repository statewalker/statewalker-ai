# @statewalker/ai-agent

A TypeScript library for building multi-turn AI agents with persistent state, tool/skill registries, MCP integration, and session management. Built on the [Vercel AI SDK](https://sdk.vercel.ai/).

The package is framework-free (no workspace-api / workbench-views / shared-adapters dependencies) — it deals only with the agent loop, state tree, tools, models, and persistence. Application-level concerns (UI, intents, fragment activators) live in `@statewalker/ai-provider-core` and the consuming apps.

## Three-tier API

```
AgentRuntime   ─→   Agent (definition)   ─→   Session (runtime instance)
```

- **`AgentRuntime`** — project-level entry point. Owns providers, tools, skills, the FilesApi split (system view vs tools view), MCP clients, session storage. Built once; stays alive for the life of the host.
- **`Agent`** — a *definition*: name, tools whitelist, skills whitelist, system prompt, default model, optional sub-agents. Cheap to construct; agents are loaded from `<systemPath>/agents/*.md` at `build()` time and can also be created programmatically.
- **`Session`** — a *runtime instance* bound to one Agent. Owns the conversation tree, inbox, per-session tool/skill views, and the loop. Persisted by id under `<systemPath>/sessions/`.

## Sub-path exports

| Export Path | Description |
|---|---|
| `@statewalker/ai-agent/runtime` | `AgentRuntime`, `Agent`, `Session`, runtime types and FilesApi helpers (`buildToolsView`, `hideUnder`, `insideSubtree`). The official entry point. |
| `@statewalker/ai-agent` | Re-exports `state`, `controller`, `mcp`, `skills`, `context`, plus a few specific tool creators. |
| `@statewalker/ai-agent/state` | `TreeNode`, `Session`, `Turn`, `Message`, `ToolCall`, `Inbox`, `ToolRegistry`, `SkillsModel`, the stream serializer (`serialize` / `deserialize`), tree factory. |
| `@statewalker/ai-agent/models` | `ModelManager`, `UnifiedProvider`, `LocalModelStorage`, model catalog, remote discovery, `verifyModelAccess`, provider/model types. |
| `@statewalker/ai-agent/config` | `ConfigManager`, `SecretsManager`, `AgentContext` interface. |
| `@statewalker/ai-agent/sessions` | `SessionManager` interface, `FilesSessionManager` (used internally by the runtime). |
| `@statewalker/ai-agent/tools` | File-system tools (`createFileTools`) and path utilities. |

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

- **System view** — full visibility. Used internally by the runtime for config, secrets, agent definition loading, skill loading, and session persistence. Never exposed to tools.
- **Tools view** — a [`FilteredFilesApi`](../../../webrun-files/packages/webrun-files-composite/) over the same root with the system path-tree hidden. Tools and skills receive this via `AgentContext.files`. Hidden paths are reported as not-existing (read/list/stats/exists return empty/false); writes/mkdir into hidden paths reject with `"Path is hidden"`.

Defaults: `setSystemPath("/.settings/")`, `setUserPath("/")`. The system path-tree contains:

| Subject | Default path | Override |
|---|---|---|
| Agents folder | `<system>/agents/` | `setAgentsPath(path)` |
| Skills folder | `<system>/skills/` | `setSkillsPath(path)` |
| Sessions folder | `<system>/sessions/` | `setSessionsPath(path)` |
| Config folder | `<system>/config/` | `setConfigPath(path)` |

If a tool needs broader access (e.g. read from `/.settings/`), it must be wired into the runtime via `addTools` and use the system view through manager-provided helpers — never through `AgentContext.files`.

## Error handling

A single error handler routes errors from every runtime-internal source:

```ts
runtime.setErrorHandler((err, ctx) => {
  // ctx?.path   — set when a FilteredFilesApi violation surfaces
  // ctx?.server — set when an MCP server interaction fails
  log.warn({ err, ctx });
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
| `setUserPath(path)` | Tools-visible root. Default `"/"`. |
| `setSessionsPath(path)` | Override sessions storage path. |
| `setConfigPath(path)` | Override config folder. |
| `setSkillsPath(path)` | Override skills folder. |
| `setAgentsPath(path)` | Override agents folder. |
| `setToolsPath(path)` | Reserved for future on-disk tool loading. |
| `addModelProvider(...providers)` | Register one or more `ProviderV3` or `ModelManager` instances. |
| `addTools(...tools)` | Register tools (`ToolSet` or `ToolFactory`). |
| `addSkills(...skills)` | Register skills programmatically. |
| `setSelectionStrategy(strategy)` | Install a fixed message-selection strategy. Mutually exclusive with `setBudgetCompaction`. |
| `setBudgetCompaction(opts)` | Install hierarchical selection + compaction. Mutually exclusive with `setSelectionStrategy`. |
| `setMcpServers(config)` | Configure MCP servers inline. |
| `setMcpConfigFile(path)` | Load MCP servers from a config file (system view). |
| `setErrorHandler(handler)` | Replace the runtime-wide error handler. |

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
- `config`, `secrets`, `models`, `mcp`

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

- `addSubAgent(child: Agent): this` — register a sub-agent. The runtime will expose it as a tool to this agent's sessions. *Not yet supported through the runtime API; throws when a Session is created.*
- `setSelectionStrategy(strategy)` — per-agent override of the runtime-level strategy.
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
| `withProvider(p)` / `withModelManager(m)` | `addModelProvider(p)` / `addModelProvider(m)` (auto-detected) |
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
