# @statewalker/ai-agent-state

Reactive state tree for AI agent conversations. Uniform data entries with typed wrappers, flat stream sync, and multiple serialization formats.

## What it is

A reactive tree model with two layers:

- **`TreeEntry`** (interface) — pure data: `{ id, props, content?, children? }`. The `type` lives in `props.type`.
- **`TreeNode`** (class, extends `BaseClass`) — reactive wrapper over `TreeEntry` data. Caches child wrappers, provides `bubbleUp()`, `visit()`, `touch()`, `update()`.
- **Typed wrappers** (`Session`, `Turn`, `Message`, `ToolCall`) — extend `TreeNode`, add domain-specific accessors.

```typescript
// Data shape (serializable)
interface TreeEntry {
  id: string;                        // Snowflake ID (Crockford base32, 13 chars)
  props: Record<string, unknown>;    // type, turnNumber, toolName, updatedAt, etc.
  content?: string;                  // text content
  children?: TreeEntry[];            // nested entries
}

// Flat shape (for sync / events / markdown)
interface FlatTreeEntry {
  id: string;
  parentId?: string;
  props: Record<string, unknown>;
  content?: string;
}
```

## Why it exists

The `@statewalker/ai-agent` package represents conversation state as a flat `AgentMessage[]` array. This lacks structure (no hierarchy), has no reactive change propagation, and gives external consumers no way to subscribe to specific parts of the conversation. This package provides a structured, observable state model while keeping things simple.

Key design principle: **uniform data + typed wrappers**. All data entries share the same `TreeEntry` shape. Wrappers (`Session`, `Turn`, `Message`, `ToolCall`) extend `TreeNode` and add typed access. A `NodeFactory` creates the right wrapper based on `props.type`.

## How to use

### Create a factory and build a tree

```typescript
import { createAgentNodeFactory, Session } from "@statewalker/ai-agent-state";

const factory = createAgentNodeFactory();

// Create a session (factory generates Snowflake ID, picks Session wrapper)
const session = factory({ type: "session" }) as Session;

// Build conversation via typed methods
const turn = session.addTurn({ turnNumber: 1 });
turn.addUserMessage("Read /tmp/data.json");
const agent = turn.addAgentMessage();
agent.appendDelta("Sure, let me read that.");

const tc = turn.addToolCall("call-001", "read_file", { path: "/tmp/data.json" });
tc.addResponse('{"name": "test"}');

turn.stopReason = "tool-use";
turn.model = "claude-sonnet-4-20250514";
turn.usage = { input: 100, output: 50 };
```

### Listen to changes

```typescript
session.onUpdate(() => {
  console.log("Something changed in the session tree");
});

// Any descendant change bubbles up to session
agent.appendDelta(" More text.");  // session listener fires
```

### Clone / sync via flat streams

```typescript
import { toFlatStream, applyFlat } from "@statewalker/ai-agent-state";

// Clone a tree
const clone = applyFlat(undefined, toFlatStream(session), factory) as Session;

// Incremental sync — only new + explicitly modified nodes
let lastId = clone.id;
clone.visit((e) => { if (e.id > lastId) lastId = e.id; });

// ... time passes, session gets new turns ...
applyFlat(clone, toFlatStream(session, lastId), factory);
```

### Serialize to JSON

```typescript
import { treeToJson, jsonToTree } from "@statewalker/ai-agent-state";

const json = treeToJson(session);             // { id, props, children: [...] }
const restored = jsonToTree(json, factory);   // fully wired TreeNode tree
```

### Serialize to markdown

```typescript
import { treeToMarkdown, markdownToTree } from "@statewalker/ai-agent-state/markdown";

const md = treeToMarkdown(session);            // flat sections with parentId
const restored = markdownToTree(md, factory);  // tree from markdown
```

## Examples

### Agent conversation tree

```
session (props.type: "session")
├── turn (turnNumber: 1, stopReason: "tool-use")
│   ├── user_message: "Read /tmp/data.json"
│   ├── agent_message: "Sure, let me read that."
│   │   └── thinking: "I should use the read tool"
│   └── tool_call (toolName: "read_file", callId: "call-001")
│       ├── tool_request (args: {path: "/tmp/data.json"})
│       └── tool_response: '{"name": "test"}'
└── turn (turnNumber: 2, stopReason: "stop")
    └── agent_message: "The file contains..."
```

### FlatTreeEntry stream

```typescript
// toFlatStream() emits entries ordered by Snowflake ID:
[
  { id: "01HGX..001", props: { type: "session" } },
  { id: "01HGX..002", parentId: "01HGX..001", props: { type: "turn", turnNumber: 1 } },
  { id: "01HGX..003", parentId: "01HGX..002", props: { type: "user_message" }, content: "Hello" },
]
```

### Custom node factory with extra types

```typescript
import { createAgentNodeFactory, TreeNode } from "@statewalker/ai-agent-state";

class CustomNode extends TreeNode {
  get myProp(): string { return this.props.myProp as string; }
}

const factory = createAgentNodeFactory({
  my_custom_type: CustomNode,
});
```

## Internals

### Architecture

```
TreeEntry (interface)     = pure data, serializable
TreeNode  (class)         = reactive wrapper, caches children via factory
Session/Turn/Message/...  = extend TreeNode, typed accessors
NodeFactory               = (data) => TreeNode — creates right wrapper by props.type
newNodeFactory(index, idGen?) = generic factory builder
createAgentNodeFactory(extra?) = pre-configured for agent types
```

### NodeFactory and ID generation

`newNodeFactory(index, idGen?)` is the core factory builder:
- Accepts `TreeEntry` (existing data with id) or `NewEntryOptions` (no id required)
- Generates Snowflake IDs via the `idGen` parameter when id is not provided
- Looks up constructor by `props.type`; unknown types get plain `TreeNode`
- All ID generation is centralized in the factory — no other code creates IDs

### Child caching

When you access `node.children`, TreeNode lazily wraps `data.children` via the factory and caches the wrappers by id. Repeated access returns the same instances. `addChild` goes through the factory, so children always get the right typed wrapper.

### Mutation methods

All mutations go through semantic methods — no direct `notify()` calls outside `TreeNode`:
- `touch()` — sets `props.updatedAt` (ISO string), calls `bubbleUp()`
- `update(props?, content?)` — merges props, replaces content, calls `bubbleUp()`
- `addChild(data)` / `removeChild(child)` — mutates `data.children`, manages cache
- `appendDelta(delta)` (on Message) — appends text, calls `touch()`
- Setters (`stopReason`, `model`, `usage`, `progressText`) — update prop, call `touch()`

### Since filter for incremental sync

`toFlatStream(root, since?)` emits nodes where:
- `id >= since` — new nodes (created after checkpoint)
- `props.updatedAt` exists AND `updatedAt >= extractTime(since)` — explicitly modified old nodes

Nodes without `props.updatedAt` are NOT emitted for `since` queries (no false positives from `createdAt` fallback).

### Snowflake IDs and ordering

IDs are Crockford base32 encoded Snowflake IDs from `@repo/ids`:

```
64-bit: [42-bit timestamp | 10-bit worker | 12-bit sequence]
     → Crockford base32, zero-padded to 13 chars
     → lexicographic string comparison = chronological order
```

### File layout

```
src/
  types.ts              ← TreeEntry, FlatTreeEntry, NewEntryOptions, NodeFactory
  node-factory.ts       ← newNodeFactory(index, idGen?) — generic
  tree-node.ts          ← TreeNode class + wrapTree()
  wrappers/
    node-types.ts       ← NodeType constants (agent-specific)
    node-factory.ts     ← createAgentNodeFactory(extra?)
    session.ts          ← Session
    turn.ts             ← Turn + Usage
    message.ts          ← Message
    tool-call.ts        ← ToolCall
    index.ts
  flat-stream.ts        ← toFlatStream()
  apply-flat.ts         ← applyFlat()
  json.ts               ← treeToJson, jsonToTree
  markdown.ts           ← treeToMarkdown, markdownToTree (separate subpath)
  index.ts              ← exports all except markdown
```

### Dependencies

- `@repo/ids` — Snowflake ID generation (Crockford base32)
- `@repo/shared` — `BaseClass` (reactive model foundation)
- `@repo/content-blocks` — only for markdown subpath (`treeToMarkdown`, `markdownToTree`)

## License

MIT
