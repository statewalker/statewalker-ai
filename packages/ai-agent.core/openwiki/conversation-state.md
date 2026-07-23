# Conversation State

The persisted state of one Session — a reactive tree of `Turn`s, `Message`s, `ToolCall`s, and `TurnGroup`s. Pure data; a typed view over `TreeNode`. The runtime-side `Session` holds an instance as its `.state` field.

## Node types

All nodes in the conversation tree are identified by a string `type` from the `NodeType` constant:

| NodeType | Description |
|---|---|
| `session` | Root node — the `SessionState` itself. |
| `turn` | One inbox-message exchange. Opens with a user message, accumulates agent messages, tool calls, tool results, closes when streaming finishes. |
| `turn_group` | A summarised run of Turns produced by compaction. Wraps adopted children; carries `depth`, `stamp`, `summaryText`, optional `sections`. |
| `step` | Inner step within a turn (AI SDK multi-step). |
| `user_message` | User-authored message. |
| `agent_message` | Agent-authored message container. |
| `thinking` | Reasoning / chain-of-thought content. |
| `text` | Text content (streamed deltas accumulate here). |
| `tool_call` | A tool invocation: name, args, result. |
| `tool_request` | Pending tool request awaiting gate decision (HITL). |
| `tool_response` | Successful tool result. |
| `tool_error` | Tool execution error. |
| `tool_output_denied` | Tool output suppressed by elision policy. |
| `tool_input` | Tool input data. |
| `source` | Source reference. |
| `file` | File reference. |
| `error` | Error node. |
| `input_rejected` | Rejected input. |

**Source**: `src/state/node-types.ts`.

## SessionState

```ts
class SessionState extends TreeNode {
  isStreaming: boolean;
  error: string;
  title: string | undefined;           // session title (first-turn generated)
  worklist: TodoItem[];                 // autonomous-continuation worklist
  turns: Turn[];                        // direct Turn children only
  allTurns(): Turn[];                   // all Turns, recursing through TurnGroups
  currentTurn: Turn | undefined;        // last direct Turn child
  addTurn(props?): Turn;
  startStreaming(): void;
  stopStreaming(error?): void;
}
```

Key properties:
- **`worklist`** — a flat list of `TodoItem` maintained by the `write_todos` tool. The `LoopExecutor` keeps driving turns while any item is open. An absent worklist reads as empty.
- **`turns`** — direct `Turn` children only (non-recursive). One inbox message → one new Turn at the root's end (invariant of the agent loop).
- **`allTurns()`** — every raw `Turn` descendant in document order, recursing through `TurnGroup` wrappers introduced by context compaction.

**Source**: `src/state/session-state.ts`.

## Turn

One inbox-message exchange — opens with a user message, accumulates agent messages, tool calls, and tool results, closes when streaming finishes. Exactly one Turn per inbox message (invariant of the agent loop).

```ts
class Turn extends TreeNode {
  turnNumber: number;
  stopReason: string | undefined;
  model: string | undefined;
  usage: Usage | undefined;             // input, output, cacheRead, cacheWrite, totalTokens
  messages: Message[];                  // user/agent/thinking/text children
  userText: string | undefined;         // first user message text
  toolCalls: ToolCall[];                // tool call children
  errors: TreeNode[];                   // error children
  addUserMessage(text: string): Message;
  addAgentMessage(): Message;
  addToolCall(callId: string, toolName: string, args?: unknown): ToolCall;
  toPlainText(): string;                // concatenated text for signatures/summaries
}
```

**Source**: `src/state/turn.ts`.

## TurnGroup

Intermediate node that wraps a contiguous range of older `Turn`s (or lower-depth `TurnGroup`s) and carries a single summary of its direct children. Produced by [context compaction](context-shaping.md#compaction).

```ts
class TurnGroup extends TreeNode {
  summaryText: string | undefined;      // prose summary (lives in node.content)
  stamp: string | undefined;             // compaction-pass id that produced this group
  depth: number;                         // 1 for children=Turns, 2 for children=groups, etc.
  sections: SummarySection[] | undefined; // structured subject sections with refs
  tokensEstimate: number;                // cached size of rendered summary
  model: string | undefined;             // model that produced the summary
}
```

`SummarySection` carries a `title`, `body`, and `refs` (node IDs of descendant Turns/groups from which this section was drawn). `refs` are the primary mechanism used by the hierarchical selector for zoom-in.

**Source**: `src/state/turn-group.ts`.

## Inbox

Async queue of pending user messages. The agent loop drains it; one `take()` per Turn.

```ts
class Inbox {
  push(message: InboxMessage): void;
  take(signal?: AbortSignal): Promise<InboxMessage | undefined>;
  get pending(): number;
}
```

`InboxMessage`: `{ role: "user" | "system"; text: string; source?: string }`.

**Source**: `src/state/inbox.ts`.

## Worklist

A flat list of `TodoItem` on `SessionState.worklist`, maintained by the `write_todos` tool. The `LoopExecutor`'s `completionGate` checks whether any item is still open — if so, the loop synthesises a continuation message from the remaining open items and keeps driving.

```ts
interface TodoItem {
  id: string;
  status: "open" | "done";
  text: string;
}

function openTodos(items: TodoItem[]): TodoItem[];  // filter to open items
```

**Source**: `src/state/worklist.ts`.

## Serialization

Session trees are serialized to/from markdown using the stream serializer:

```ts
async function sessionToMarkdown(root: TreeNode): Promise<string>;
async function markdownToSession(markdown: string, factory: NodeFactory): Promise<TreeNode>;
```

Each `FlatTreeEntry` becomes one markdown block; hierarchy (id/parentId) lives in props. `FilesSessionManager` uses this to persist sessions as `<sessionsDir>/<id>/<id>.md`.

The serialization pipeline:
1. `toFlatStream(root)` → `FlatTreeEntry[]` (tree to flat entries with id/parentId/props/content)
2. `serialize(flatToNodes(...))` → markdown chunks (stream serializer)
3. Reverse: `deserialize([markdown])` → `Node[]` → `nodeToFlat` → `FlatTreeEntry[]` → `applyFlat(undefined, flat, factory)` → `TreeNode`

**Source**: `src/state/session-serialization.ts`, `src/state/serialization/` (`serialize.ts`, `deserialize.ts`, `to-flat-stream.ts`, `apply-flat.ts`).

## TreeNode

The underlying typed node primitive. Implementation detail of the state tree — callers work through `SessionState`/`Turn`/`Message`/etc. accessors. Extends `BaseClass` from `@statewalker/shared-baseclass` for reactivity (`onUpdate`, `notify`, `touch`).

**Source**: `src/state/tree-node.ts`.
