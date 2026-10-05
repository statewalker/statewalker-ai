# @statewalker/ai-agent.core

## What it is

A TypeScript library for multi-turn AI agents built on the Vercel AI SDK (`ai`). It runs the agent loop, keeps each conversation as a persisted state tree, shapes the context for every model call, and provides tool and skill registries, MCP (HTTP/SSE) integration, built-in file tools, local-model management and session persistence. It works on a `FilesApi` from `@statewalker/webrun-files` and has no UI and no workspace dependency.

## Why it exists

An agent needs the same machinery wherever it runs: a turn loop, a conversation tree that survives restarts, a way to fit long histories into a context window, and a controlled view of the files its tools may touch. This package does that and nothing else. It does not know about workspaces, adapters or UI, so it works in a browser app, a CLI or a server; the workspace integration lives in `@statewalker/ai-agent-runtime.core`.

## How to use

```sh
pnpm add @statewalker/ai-agent.core
```

There are no peer dependencies. Add the AI SDK provider packages you use (for example `@ai-sdk/anthropic`) and a `FilesApi` implementation (for example `@statewalker/webrun-files-node` or `@statewalker/webrun-files-mem`).

The package root exports nothing. Import from the sub-paths:

| Import path | Main exports |
| --- | --- |
| `@statewalker/ai-agent.core/runtime` | `AgentRuntime`, `Agent`, `Session`, `LoopExecutor`, `FsmExecutor`, `withFirstTurnTitle`, gates (`completionGate`, `controllerGate`, `newRunState`, `turnSignature`, `DEFAULT_MAX_TURNS`), types (`AgentDefinition`, `AgentRuntimeOptions`, `AgentRuntimeErrorHandler`, `ToolInput`, `SkillInfo`, `McpServerConfig`, `Executor`, FSM process types). |
| `@statewalker/ai-agent.core/state` | `SessionState`, `Turn`, `TurnGroup`, `Message`, `ToolCall`, `TreeNode`, `NodeType`, `createAgentNodeFactory`, `Inbox`, `ToolRegistry`, `SkillsModel`, `openTodos`; types `LogMessage`, `TurnFinishKind`, `InboxMessage`, `TodoItem`, … |
| `@statewalker/ai-agent.core/models` | `ModelManager`, `ModelStateStore`, `LocalModelStorage`, `createDefaultCatalog`, `mergeCatalogs`, `createRemoteProvider`, `listModels`, `verifyModelAccess`, provider-name and model-kind constants, model types (`ModelProvider`, `LocalModelConfig`, `RemoteModelConfig`, `ModelStatus`, …). |
| `@statewalker/ai-agent.core/tools` | `createFileTools(files)`. |

The three objects you work with:

```
AgentRuntime ──createAgent()──► Agent ──createSession()──► Session ──run()──► LogMessage stream
 providers, tools, skills,       name, allowed tools/skills,   conversation tree, inbox,
 MCP, sessions, FilesApi views   system prompt, model, limits  per-session tools/skills
```

- `new AgentRuntime({ files, errorHandler? })`, then `setSystemPath`, `addModelProvider`, `addTools`, `addSkills`, `setMcpServers` (each returns `this`), then `await build()`.
- `runtime.createAgent(def)`, `getAgent(name)`, `agents()`; `loadSession(id)`, `listSessions()`, `deleteSession(id)`, `getSessionMetadata(id)`, `setSessionModelRef(id, ref)`.
- `agent.createSession({ title?, sessionId? })`.
- `session.send(text)`, `session.run(signal?)`, `session.save({ title? })`, `session.close()`.

## Examples

### Run one exchange with an agent

```ts
import { createAnthropic } from "@ai-sdk/anthropic";
import { AgentRuntime } from "@statewalker/ai-agent.core/runtime";
import { createFileTools } from "@statewalker/ai-agent.core/tools";
import { NodeFilesApi } from "@statewalker/webrun-files-node";

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
  if (log.type === "text-delta") process.stdout.write(log.text);
  if (log.type === "turn-finish") break; // run() would otherwise wait for the next message
}

const id = await session.save();
const resumed = await runtime.loadSession(id);
```

### Restrict an agent to some tools and skills

```ts
const analyst = runtime.createAgent({
  name: "analyst",
  tools: ["read_file", "grep"], // undefined → all runtime tools
  skills: ["analyze-csv"],      // undefined → all runtime skills
  maxSteps: 8,                  // tool-call steps per turn
  maxTurns: 4,                  // autonomous continuations per user message
});
```

Every session also gets the built-in `list_tools` and `write_todos` tools, and `list_skills` and `use_skills` when it has skills.

### Stop a running session with a signal

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 60_000);
for await (const log of session.run(controller.signal)) {
  if (log.type === "tool-call") console.log("tool:", log.toolName, log.args);
  if (log.type === "error") console.error(log.message);
}
```

### Route runtime errors

```ts
const runtime = new AgentRuntime({
  files,
  errorHandler: (err, ctx) => {
    // ctx?.path   — FilesApi and definition-file errors
    // ctx?.server — MCP server errors
    console.warn(err, ctx);
  },
});
```

### Connect an MCP server

```ts
runtime.setMcpServers({
  docs: { url: "https://example.com/mcp", type: "http", headers: { Authorization: "Bearer …" } },
});
```

Only remote MCP servers (`"http"` or `"sse"`) are supported. Their tools are added to every session.

### Use the file tools on their own

```ts
import { createFileTools } from "@statewalker/ai-agent.core/tools";

const tools = createFileTools(files); // ToolSet for streamText / generateText
```

The set contains `get_current_time`, `read_file`, `read_lines`, `write_file`, `edit_file`, `multi_edit`, `replace_lines`, `delete_file`, `move_file`, `list_files`, `search_files`, `grep`, `file_info`, `count_lines` and `create_directory`.

### Define skills and agents as markdown files

Files in `<systemPath>/skills/*.md` become skills and files in `<systemPath>/agents/*.md` become agent definitions when `build()` runs. Both use `key: value` frontmatter:

```markdown
---
name: analyze-csv
description: Read a CSV and produce a summary statistics report.
---

Instructions for the model when this skill is used.
```

Without frontmatter, the first `# heading` is the name and the first paragraph the description. For an agent file the body becomes the system prompt. Agents registered with `createAgent` before `build()` take precedence over files with the same name; after `build()`, `createAgent` with a name loaded from a file throws.

## Internals

### Tools never see the system folder

`build()` creates two views over the `FilesApi` given to the constructor:

```
root FilesApi
├── /.settings/        ◄── system view (runtime.systemFiles): config, agents/, skills/, sessions/
└── everything else    ◄── tools view (runtime.files): /.settings hidden
```

Tool factories and skills receive only the tools view (`AgentContext.files`). Hidden paths look absent on reads, and writes into them reject with `"Path is hidden"`. This keeps a tool from reading or overwriting saved sessions and agent definitions. The system path defaults to `/.settings`; the sub-layout (`/agents`, `/skills`, `/sessions`, config at `/`) is fixed. A system path of `/` would hide everything, so `build()` rejects it.

### Context shaping

Each session owns a `ContextWindow` that turns the conversation tree and active skills into `{ system, messages }` for the next model call. It runs compaction (old turns are wrapped in summarised `TurnGroup`s, never dropped), selection, elision, pin policy and system-prompt assembly. The runtime uses the package defaults; `ContextWindow` is internal and not exported. See [openwiki/context-shaping.md](openwiki/context-shaping.md).

### The loop

`Session.run()` hands control to the agent's `Executor`. The default `LoopExecutor` takes one inbox message, drives a turn, and keeps driving while the worklist (`write_todos`) has open items, until a new message arrives, the work is done, or the turn budget (`maxTurns`, default `DEFAULT_MAX_TURNS`) or stagnation gate stops it. Then it waits for the next inbox message. `FsmExecutor` drives turns from an FSM process definition instead. See [openwiki/agent-loop.md](openwiki/agent-loop.md).

### Constraints

- `addModelProvider` accepts several providers, but only the first one is used.
- `build()` runs once; later calls return the same runtime. Tools, skills and MCP servers added after `build()` are ignored.
- `build()` throws `AgentRuntime: no model provider configured. Use .addModelProvider()` when no provider was added. Configuration errors go to the error handler and are also thrown.
- `createAgent` throws `AgentRuntime: agent already registered: <name>` for a duplicate name.
- `session.run()` on a closed session throws `Session: closed`.

### Dependencies

- `ai`, `@ai-sdk/provider`, `@ai-sdk/provider-utils`: model calls, tool definitions, provider types.
- `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/openai`: `createRemoteProvider` and remote model discovery.
- `@ai-sdk/mcp`, `@modelcontextprotocol/sdk`: MCP clients over HTTP/SSE.
- `@statewalker/webrun-files`, `@statewalker/webrun-files-composite`: the `FilesApi` and the filtered and composite views.
- `@statewalker/fsm`: `FsmExecutor`.
- `@statewalker/shared-baseclass`, `@statewalker/shared-ids`: observable state objects and session ids.
- `zod`: tool input schemas.

More: [openwiki/](openwiki/quickstart.md) (architecture, state, context shaping, loop, tools, models) and [CONTEXT.md](CONTEXT.md) (glossary).

## License

MIT
