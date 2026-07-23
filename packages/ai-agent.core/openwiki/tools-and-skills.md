# Tools & Skills

How the agent accesses external capabilities: the per-session `ToolRegistry`, built-in file tools, MCP integration, the skills system, and the worklist tool.

## ToolRegistry

Per-session collection of named tools available to the agent. Built from runtime-wired tools plus MCP-bridged tools plus per-Agent whitelist. Extends `BaseClass` for reactivity.

```ts
class ToolRegistry extends BaseClass {
  register(name: string, tool: Tool): () => void;  // returns unregister function
  toToolSet(): ToolSet;                              // Vercel AI SDK ToolSet — called on each turn
  get size(): number;
}
```

### Construction

When `Agent.createSession()` builds a session, it creates a `ToolRegistry` and populates it by filtering the runtime's `resolvedTools` through the Agent's declared `tools` whitelist:

```ts
const allowedTools = def.tools;  // string[] | undefined
for (const [name, tool] of Object.entries(runtime.resolvedTools)) {
  if (!allowedTools || allowedTools.includes(name)) {
    tools.register(name, tool);
  }
}
```

If `tools` is empty/undefined, all runtime-registered tools are available.

### Built-in tools

The following tools are registered by `Agent.createSession()` in addition to the runtime's resolved tools:

| Tool | Purpose | Source |
|---|---|---|
| `write_todos` | Replace the session worklist — drives autonomous continuation. | `src/tools/write-todos-tool.ts` |
| `list_tools` | List available tools to the model. | `src/tools/list-tools-tool.ts` |
| `list_skills` | List available skills to the model. | `src/tools/list-skills-tool.ts` |
| `use_skills` | Search and activate skills. Registered only when the Agent's skill set is non-empty. | `src/tools/use-skills-tool.ts` |

**Source**: `src/state/tool-registry.ts`, `src/runtime/agent.ts` (registration logic).

## File tools

15 built-in file-operation tools, created via `createFileTools(files: FilesApi)`. Path-tree visibility is the `FilesApi`'s responsibility — the runtime hands tools the filtered tools view where hidden paths already reject writes and report as not-existing on reads.

| Tool name | Purpose |
|---|---|
| `get_current_time` | Returns current timestamp. |
| `read_file` | Read full file content. |
| `read_lines` | Read specific line range with offset/limit. |
| `write_file` | Write content to a file (creates or overwrites). |
| `edit_file` | Exact string replacement in a file. |
| `multi_edit` | Multiple edits in one call. |
| `replace_lines` | Replace a line range with new content. |
| `delete_file` | Delete a file. |
| `move_file` | Move/rename a file. |
| `list_files` | List directory contents. |
| `search_files` | Find files matching a glob pattern. |
| `grep` | Search file contents (literal text). |
| `file_info` | File metadata (size, timestamps). |
| `count_lines` | Count lines in a file. |
| `create_directory` | Create a directory. |

```ts
import { createFileTools } from "@statewalker/ai-agent/tools";

const tools = createFileTools(files);
// → { get_current_time, read_file, read_lines, write_file, ... }
```

**Source**: `src/tools/file-tools/file-tools.ts`, individual tool files in `src/tools/file-tools/`.

## MCP integration

### McpClientManager

Manages MCP (Model Context Protocol) server connections. Connects to HTTP/SSE MCP servers and exposes their tools as Vercel AI SDK `ToolSet`.

```ts
class McpClientManager extends BaseClass {
  setErrorHandler(handler: McpErrorHandler): this;
  async loadServers(servers: Record<string, McpServerConfig>, signal?: AbortSignal): Promise<void>;
  get tools(): ToolSet;
  async closeAll(): Promise<void>;
}

interface McpServerConfig {
  url: string;
  type?: "http" | "sse";
  headers?: Record<string, string>;
}
```

### bridgeMcpTools

Syncs MCP tools into a `ToolRegistry`. Listens for `McpClientManager` updates and re-registers tools when MCP servers change.

```ts
function bridgeMcpTools(mcp: McpClientManager, registry: ToolRegistry): () => void;
```

Returns a cleanup function that stops listening and unregisters all MCP tools.

### Runtime integration

When `setMcpServers(config)` is called, `AgentRuntime.build()` creates an `McpClientManager`, connects to the configured servers, and the `Agent.createSession()` method bridges the MCP tools into the session's `ToolRegistry`. The bridge's cleanup function is stored as `mcpUnsubscribe` on the `Session`.

MCP errors flow through the runtime's `errorHandler` with `ctx.server` set.

**Source**: `src/mcp/mcp-client-manager.ts`, `src/mcp/bridge-mcp-tools.ts`.

## Skills

### Skill format

Skills are markdown files under `<systemPath>/skills/` with YAML-like frontmatter:

```markdown
---
name: analyze-csv
description: Read a CSV and produce a summary statistics report.
---

(skill body — instructions for the LLM when this skill is selected)
```

`name` and `description` are required. Additional keys are passed through as metadata. If no frontmatter is found, the parser uses the first `# heading` as name and the first paragraph as description.

The parser is a lightweight `key: value` parser — no external YAML library, browser-compatible.

**Source**: `src/skills/skill-parser.ts` (`parseSkillMarkdown`), `src/skills/skill-types.ts` (`SkillInfo`).

### SkillsModel

Per-session collection of `available` and `selected` skills. Built by `Agent.createSession()` from the runtime's `resolvedSkills`, filtered by the Agent's declared `skills` whitelist.

- **`available`** — all skills the agent can access.
- **`selected`** — skills currently activated by the model via `use_skills`. Their content is injected into the system prompt.

When `skills.available.length > 0`, the `TurnDriver` runs skill selection on the first turn — a model-backed call that picks relevant skills for the user's prompt.

### System prompt injection

When the active session exposes at least one skill, the `ContextWindow` appends a `SKILLS_INSTRUCTION` block to the system prompt:

```
## Skills
You have access to specialized skills. Use the `use_skills` tool to search
and activate skills relevant to the current task. Once activated, skills
persist across turns until you reset them.
- Search: use_skills({ prompt: "describe the problem" })
```

**Source**: `src/state/skills-model.ts`, `src/context/context-window.ts` (`SKILLS_INSTRUCTION`).

## write_todos tool

The worklist tool the autonomous loop reads. The model calls it to replace the whole worklist; the `LoopExecutor` keeps driving while any item is open and stops when all are done.

```ts
function createWriteTodosTool(state: SessionState): Tool;
```

Input schema:
```ts
{
  todos: Array<{
    id: string;          // stable identifier within the worklist
    status: "open" | "done";
    text: string;        // short description of the task
  }>
}
```

The tool replaces `state.worklist` entirely and returns `{ count, open }`. The `LoopExecutor`'s `completionGate` checks `openTodos(state.worklist)` — if any item is still open, the loop synthesizes a continuation message and keeps driving.

**Source**: `src/tools/write-todos-tool.ts`, `src/state/worklist.ts`.
