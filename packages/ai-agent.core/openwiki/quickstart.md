# @statewalker/ai-agent.core — OpenWiki Quickstart

TypeScript library for building multi-turn AI agents with persistent conversation state, context shaping (hierarchical compaction, selection, elision), tool/skill registries, MCP integration, model management, and session persistence. Built on the [Vercel AI SDK](https://sdk.vercel.ai/). Framework-free — no UI, no workspace-adapter coupling.

## What this package does

- **Agent loop** — drains an inbox of user messages, streams LLM responses via `streamText`, routes tool calls, and advances the conversation tree one Turn per message. Supports autonomous multi-step bursts driven by a worklist.
- **Conversation state** — a reactive tree of `Turn` → `Message` / `ToolCall` / `TurnGroup` nodes (`SessionState`), persisted as markdown. Compaction wraps old turns in summarised `TurnGroup` wrappers when token budgets are exceeded — never drops data.
- **Context shaping** — `ContextWindow.build()` produces `{ system, messages, events, stats }` for each model call by running compaction, selection, elision, pin policy, and system-prompt assembly.
- **Tools & skills** — per-session `ToolRegistry` with 15 built-in file tools, MCP server bridging, and markdown-loaded skills injected into the system prompt.
- **Models** — `ModelManager` manages local-engine model lifecycle (download, verify, activate). `ModelStateStore` implements `ProviderV3` directly. Cloud providers (Anthropic, OpenAI, Google) are passed in as `ProviderV3`.
- **Persistence** — sessions serialised by id under `<systemPath>/sessions/` as markdown, with a shared `index.json` metadata index.

## Three-tier API

```
AgentRuntime   ─→   Agent (definition)   ─→   Session (runtime instance)
```

- **`AgentRuntime`** — project-level entry point. Owns providers, tools, skills, the FilesApi split (system view vs tools view), MCP clients, session storage. Built once; stays alive for the host process.
- **`Agent`** — a *definition*: name, tools whitelist, skills whitelist, system prompt, default model, optional executor. Cheap to construct. Loaded from `<systemPath>/agents/*.md` at `build()` time or created programmatically.
- **`Session`** — a *runtime instance* bound to one Agent. Owns the conversation tree, inbox, per-session tool/skill views, and the loop. Persisted by id under `<systemPath>/sessions/`.

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
  console.log(log.type, log);
}

const id = await session.save();
// later: const resumed = await runtime.loadSession(id);
```

## Sub-path exports

| Export Path | Description |
|---|---|
| `@statewalker/ai-agent/runtime` | `AgentRuntime`, `Agent`, `Session`, `Executor`, `LoopExecutor`, `FsmExecutor`, gates, runtime types. The official entry point. |
| `@statewalker/ai-agent/state` | `SessionState`, `Turn`, `TurnGroup`, `Message`, `ToolCall`, `Inbox`, `ToolRegistry`, `SkillsModel`, `NodeType`, `TreeNode`, `LogMessage`, `openTodos`. |
| `@statewalker/ai-agent/models` | `ModelManager`, `ModelStateStore`, `LocalModelStorage`, model catalog, remote discovery, `verifyModelAccess`, provider/model types. |
| `@statewalker/ai-agent/tools` | `createFileTools` and path utilities. |

The bare `@statewalker/ai-agent` root is intentionally empty — use a sub-path.

## Documentation sections

- [Architecture](architecture.md) — three-tier model, module map, FilesApi split, error handling, public surface
- [Conversation State](conversation-state.md) — SessionState tree, node types, Turn/TurnGroup/Message/ToolCall, serialization
- [Context Shaping](context-shaping.md) — ContextWindow, compaction, selection, elision, pin policy, system prompt assembly
- [Agent Loop](agent-loop.md) — Executor interface, LoopExecutor, FsmExecutor, TurnDriver, gates, worklist, LogMessage stream
- [Tools & Skills](tools-and-skills.md) — ToolRegistry, file tools, MCP integration, skills system, built-in tools
- [Models & Persistence](models-and-persistence.md) — ModelManager, ModelStateStore, session persistence, ConfigManager

## Existing documentation

- [README.md](../README.md) — published API reference with full method signatures and migration table
- [CONTEXT.md](../CONTEXT.md) — domain language glossary
- [README.draft.md](../README.draft.md) — v2 direction draft (Commands substrate, tree-mutation control surface)
- [ADR 0001](../docs/adr/0001-ai-agent-stays-in-workbench.md) — why this package lives in workbench as `.core`
