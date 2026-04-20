# @statewalker/ai-agent

A TypeScript framework for building multi-turn AI agents with persistent state, tool registries, skills, MCP integration, and session management. Built on the [Vercel AI SDK](https://sdk.vercel.ai/), it provides a complete agent lifecycle — from construction via a fluent builder API to conversation execution, context management, and session persistence.

## Architecture Overview

```
                          AgentBuilder
                              |
         .withProvider()  .withFilesApi()  .withTools()  .withSkillsFolder()
                              |
                          .build()
                              |
                   +----------+----------+
                   |                     |
              AgentController        AgentContext
              (LLM loop)        (files, config, sessions)
                   |
    +--------------+--------------+
    |              |              |
  Inbox       ToolRegistry   SkillsModel
 (messages)   (tools + MCP)   (knowledge)
    |              |
  Session      Tool execution
  (tree)       (file ops, sub-agents, custom)
```

## Packages and Sub-path Exports

| Export Path | Description |
|---|---|
| `@statewalker/ai-agent` | Main entry: controller, provider, skills, context, MCP, state |
| `@statewalker/ai-agent/builder` | `AgentBuilder`, `Agent`, `AgentManager`, `SubAgentTool` |
| `@statewalker/ai-agent/tools` | 12 file-system tools + path utilities |
| `@statewalker/ai-agent/config` | `ConfigManager`, `SecretsManager`, `AgentContext` |
| `@statewalker/ai-agent/sessions` | `FilesSessionManager`, `SessionManager` interface |
| `@statewalker/ai-agent/state` | `Session`, `Turn`, `Message`, `ToolCall`, `Inbox`, registries |

## Quick Start

```typescript
import { AgentBuilder } from "@statewalker/ai-agent/builder";
import { createFileTools } from "@statewalker/ai-agent/tools";
import { NodeFilesApi } from "@statewalker/webrun-files-node";

const files = new NodeFilesApi({ rootDir: "/my/project" });

const agent = await new AgentBuilder()
  .withProvider("anthropic", process.env.ANTHROPIC_API_KEY)
  .withModel("claude-sonnet-4-20250514")
  .withFilesApi(files)
  .withSystemFolder("/.settings")
  .withExcludedPaths(".git", "node_modules")
  .withTools((ctx) => createFileTools(ctx.files, {
    excludedPrefixes: ["/.settings/", "/.git/", "/node_modules/"],
  }))
  .withSkillsFolder("/.settings/skills/")
  .withSystemPrompt("You are a coding assistant.")
  .build();

agent.inbox.push({ role: "user", text: "List files in src/" });

for await (const event of agent.run()) {
  if (event.type === "text-delta") process.stdout.write(event.text);
}
```

## Core Components

### AgentBuilder

Fluent builder that assembles all agent components and produces an `Agent` instance. The `build()` method resolves everything in order:

1. **Provider** from name + API key or pre-built `ProviderV3`
2. **File system split** into system files and working files (see [Security Model](#file-system-security-model))
3. **ConfigManager** and **SecretsManager** backed by system files
4. **SessionManager** for conversation persistence
5. **AgentContext** connecting all of the above
6. **Tool factories** resolved with the context
7. **Skills** loaded from folder and/or registered directly
8. **MCP servers** connected and bridged into the tool registry
9. **Sub-agent tools** registered for delegation

Builder methods: `withProvider()`, `withModel()`, `withFilesApi()`, `withSystemFolder()`, `withExcludedPaths()`, `withTools()`, `withSkills()`, `withSkillsFolder()`, `withMcpServers()`, `withMcpConfigFile()`, `withSubAgent()`, `withSessionManager()`, `withSystemPrompt()`, `withMaxSteps()`, `withSelectionStrategy()`.

### AgentController

The core conversation loop. Takes messages from an `Inbox`, runs LLM turns via Vercel AI SDK's `streamText()`, executes tool calls, and updates the `Session` tree. Yields `LogMessage` events for streaming output.

```typescript
interface AgentControllerConfig {
  provider: ProviderV3;
  model: string;
  session?: Session;
  inbox?: Inbox;
  tools?: ToolRegistry;
  skills?: SkillsModel;
  systemPrompt?: string;
  maxSteps?: number;        // default: 10
  select?: SelectionStrategy;
}
```

The controller automatically registers three built-in tools: `list_tools`, `list_skills`, and `use_skills`.

### Agent

Thin wrapper around `AgentController` + `AgentContext`:

- `run(signal?)` — runs the agent loop, yields `LogMessage` events
- `save(title?)` — persists current session, returns session ID
- `resume(id)` — loads a saved session and replaces the current conversation
- `inbox` — push messages for the agent to process
- `session` — the live conversation tree

### AgentManager

Manages multiple agent sessions with auto-save on switch:

```typescript
const manager = new AgentManager(builder);
const agent = await manager.create("My chat");

// Later — switch sessions (auto-saves current)
const resumed = await manager.resume(previousId);
const sessions = await manager.list();
await manager.delete(oldId);
```

## File System Security Model

The `AgentBuilder` enforces a strict separation between **system files** and **working files**. When a `FilesApi` and system folder are configured, the builder creates two isolated views:

### System Files (`AgentContext.systemFiles`)

The full, unguarded file system. Used internally by `ConfigManager`, `SecretsManager`, and `SessionManager` to store agent configuration, API keys, credentials, and session data under the system folder (default: `/.settings/`).

**Not exposed to tools or the LLM.**

### Working Files (`AgentContext.files`)

A guarded file system that **blocks write, remove, and move operations** targeting:
- The system folder (e.g., `/.settings/`)
- Any additional excluded paths (e.g., `.git/`, `node_modules/`)

This is the file system passed to tool factories and used by the 12 built-in file tools. The LLM can read, write, edit, and search files — but cannot modify agent configuration, secrets, or session data.

```
Root FilesApi
  |
  +-- systemFiles (full access) --> ConfigManager, SecretsManager, SessionManager
  |
  +-- workingFiles (guarded)    --> Tool factories, file tools
        |
        +-- /.settings/  BLOCKED (write/remove/move denied)
        +-- /.git/        BLOCKED
        +-- /node_modules/ BLOCKED
        +-- /src/          allowed
        +-- /docs/         allowed
```

This split uses `CompositeFilesApi` from `@statewalker/webrun-files-composite` with path-prefix guards. A `PathExcludedError` is thrown if a tool attempts to write to a protected path.

## State Tree

Conversations are modeled as a tree of `TreeNode` instances (from `@statewalker/ai-agent-state`):

```
Session
  +-- Turn 1
  |     +-- user_message "What is X?"
  |     +-- agent_message
  |     |     +-- text "Here's X..."
  |     |     +-- thinking "Let me reason..."
  |     +-- tool_call (call_1)
  |     |     +-- tool_request {callId, toolName, args}
  |     |     +-- tool_response "Result..."
  |     +-- error (if any)
  +-- Turn 2
        +-- ...
```

### Key State Classes

| Class | Extends | Role |
|---|---|---|
| `Session` | `TreeNode` | Root node, manages turns and streaming state |
| `Turn` | `TreeNode` | Single LLM interaction with messages, tool calls, usage stats |
| `Message` | `TreeNode` | User, assistant, or thinking text with streaming delta support |
| `ToolCall` | `TreeNode` | Tool invocation: request args + response result |
| `Inbox` | `BaseClass` | Async message queue with `push()`/`take()` |
| `ToolRegistry` | `BaseClass` | Named tool map with subscribe-on-change |
| `SkillsModel` | `BaseClass` | Skill registration, selection, and activation |

### Serialization

Sessions serialize to markdown via `sessionToMarkdown()` / `markdownToSession()`. Tool requests and responses are encoded as fenced code blocks (`llm:tool-params`, `llm:tool-response`).

## Tools

### Built-in File Tools (12)

Created via `createFileTools(files, { excludedPrefixes })`:

| Tool | Description |
|---|---|
| `read_file` | Read text files (max 50K chars, range support, rejects binary) |
| `write_file` | Write/create files with auto-directory creation |
| `edit_file` | Single find-and-replace with optional `replace_all` |
| `multi_edit` | Atomic batch of find-and-replace edits |
| `delete_file` | Remove files or directories recursively |
| `move_file` | Move or rename files |
| `list_files` | Directory listing with glob patterns (`*`, `**`, `?`) |
| `search_files` | Regex search across file contents |
| `grep` | Advanced search with context lines, output modes, pagination |
| `file_info` | File metadata (size, kind, last modified) |
| `create_directory` | Create directories with parents |
| `get_current_time` | Current date/time with timezone support |

All file tools validate paths against the excluded-prefix filter before operating. Protected paths throw `PathExcludedError`.

### Built-in Agent Tools (3)

Automatically registered by `AgentController`:

| Tool | Description |
|---|---|
| `list_tools` | Returns descriptions and parameter schemas for all registered tools |
| `list_skills` | Returns available skill names and descriptions |
| `use_skills` | Uses the LLM to select relevant skills from a prompt, then activates them |

### Custom Tools

Register static tools or factories that receive `AgentContext`:

```typescript
builder
  .withTools({ my_tool: tool({ ... }) })           // static ToolSet
  .withTools((ctx) => ({                            // factory with context
    search_docs: tool({
      description: "Search project docs",
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        // ctx.files, ctx.config, ctx.secrets available
      },
    }),
  }));
```

### Sub-Agent Tools

Register child agents as tools for delegation:

```typescript
builder.withSubAgent("researcher", (parent) =>
  new AgentBuilder()
    .withProvider(parent.provider)
    .withModel(parent.model)
    .withFilesApi(parent.files)
    .withSystemPrompt("You are a research assistant.")
);
```

When the LLM calls the sub-agent tool, a fresh child agent is built, runs to completion, and returns its final text. Sub-agents do not receive their own sub-agent tools (prevents infinite recursion).

## Skills

Skills are reusable knowledge blocks (markdown files with frontmatter) that extend the system prompt:

```markdown
---
name: code-review
description: Reviews code for quality and correctness
---
When reviewing code, check for:
- Logic errors and edge cases
- Security vulnerabilities (OWASP top 10)
- Performance bottlenecks
...
```

Skills are loaded from a folder (`withSkillsFolder()`) or registered directly (`withSkills()`). The agent can dynamically select relevant skills via the `use_skills` tool.

## MCP Integration

Connect to Model Context Protocol servers:

```typescript
builder.withMcpServers({
  "my-server": { url: "http://localhost:3000/mcp", type: "http" },
});
```

`McpClientManager` handles connections, and `bridgeMcpTools()` syncs MCP-provided tools into the `ToolRegistry`, automatically updating when the MCP server's tool list changes.

## Configuration and Secrets

### ConfigManager

Generic JSON configuration loader/saver backed by `FilesApi`. Supports optional Zod schema validation:

```typescript
const data = await ctx.config.load("settings.json", mySchema);
await ctx.config.save("settings.json", { theme: "dark" });
```

### SecretsManager

API key and credentials management:

```typescript
const key = await ctx.secrets.getApiKey();          // reads /key.json
await ctx.secrets.saveApiKey({ apiKey, provider, models });
const creds = await ctx.secrets.getCredentials("github"); // reads /credentials/github.json
```

## Session Persistence

`FilesSessionManager` stores sessions as markdown files in a folder-per-session layout with a JSON index:

```
/.settings/sessions/
  +-- index.json                    # {sessions: SessionMetadata[]}
  +-- 7192837465012/
  |     +-- 7192837465012.md        # treeToMarkdown(session)
  +-- 7192837465013/
        +-- 7192837465013.md
```

Session IDs are Snowflake IDs. The index auto-rebuilds from directory scanning if missing.

## Context Selection Strategies

Three built-in strategies for managing context window usage:

| Strategy | Description |
|---|---|
| `selectAll` | All turns sent verbatim (simple, grows unbounded) |
| `selectWithCompaction` | Older turns summarized via LLM, recent N turns kept verbatim. Summaries cached on Turn nodes. |
| `selectHierarchical` | Token-budget-driven tree-growing compaction. Old turns get wrapped under `TurnGroup` parent nodes carrying a single subject-structured summary. Groups can themselves be promoted under deeper parents; unbounded depth. Pinning, tool-result elision, and expand-on-pin all built in. |

```typescript
import { selectWithCompaction, createContentSummarizer } from "@statewalker/ai-agent";

builder.withSelectionStrategy(
  selectWithCompaction({
    summarizer: createContentSummarizer({ model: languageModel }),
    maxRecentTurns: 4,
  })
);
```

### Budget compaction (hierarchical)

Preferred strategy for long-running sessions. Opts in via a single builder call:

```typescript
import { createHierarchicalSummarizer } from "@statewalker/ai-agent";

builder.withBudgetCompaction({
  budgetTokens: 120_000,                             // ~70% of 200k context
  summarizer: createHierarchicalSummarizer({         // two prompts (depth-1 / depth-k)
    model: languageModel,                            // or: { depth1, depthK }
  }),
  // Optional — defaults shown:
  keepRecentTurns: 4,
  groupSize: 6,
  depthPromoteThreshold: 4,
  // estimator / pinPolicy / elisionPolicy default to the package defaults.
});
```

What happens:
- Before each `streamText`, `ContextCompactor.compact(session, ...)` runs. If the session exceeds `budgetTokens`, older turns are wrapped under `TurnGroup` nodes whose `node.content` holds the LLM-generated summary prose (readable in markdown dumps) and whose `node.props.sections` hold structured `{ title, body, refs }` entries.
- Raw turns are never dropped — groups are non-destructive overlays. A `TurnGroup` can be expanded back via `TreeNode.ungroup(wrapper)`.
- The hierarchical selector emits one synthetic `user`-role message per group, tagged `[group:{stamp}]`. The model can cite those ids in its reply.
- Pinning forces expansion: any group containing a pinned descendant (latest user message, latest stateful tool output, `props.pinned: true`) is rendered as raw turns instead of a summary.
- Over-budget projections demote deepest non-pinned expansions first.
- Oversized `tool_response` bodies are elided at projection time (never mutating the tree); pre-registered stateful tools (`list_tools`, `list_skills`, `use_skills`) are never elided.
- If no compaction can bring the session under budget after `maxPassesPerCompact` passes (default 8), a `context-thrash` LogMessage event is emitted and compaction returns best-effort.

## Provider Support

Built-in factory for three providers:

| Provider | Package | Embeddings |
|---|---|---|
| Anthropic | `@ai-sdk/anthropic` | Not supported |
| OpenAI | `@ai-sdk/openai` | Supported |
| Google | `@ai-sdk/google` | Supported |

```typescript
builder.withProvider("anthropic", apiKey);
// or
builder.withProvider(customProviderInstance);
```

`verifyModelAccess()` validates API key and model availability with a minimal test call.

## Event Stream

`Agent.run()` yields `LogMessage` events for real-time UI rendering:

| Event Type | Fields | Description |
|---|---|---|
| `text-delta` | `turnId`, `text` | Incremental text from the LLM |
| `reasoning` | `turnId`, `text` | Thinking/reasoning text |
| `tool-call` | `turnId`, `toolCallId`, `toolName`, `args` | Tool invocation started |
| `tool-result` | `turnId`, `toolCallId`, `toolName`, `result` | Tool execution completed |
| `step-finish` | `turnId`, `finishReason` | LLM step finished |
| `error` | `turnId`, `message` | Error occurred |

## Dependencies

| Package | Role |
|---|---|
| `ai` | Vercel AI SDK core (`streamText`, `tool`, `ToolSet`) |
| `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/openai` | LLM provider adapters |
| `@ai-sdk/mcp` | MCP client creation |
| `@modelcontextprotocol/sdk` | MCP transport (HTTP/SSE) |
| `@statewalker/ai-agent-state` | TreeNode, BaseClass, serialization |
| `@statewalker/webrun-files` | FilesApi interface |
| `@statewalker/webrun-files-composite` | CompositeFilesApi with mount points and guards |
| `@repo/ids` | Snowflake ID generation |
| `@repo/shared` | Shared model adapters |
| `zod` | Schema validation |

## License

MIT
