# @statewalker/ai-agent-state

Reactive state tree for AI agent conversations. Uniform tree of entries — like JSX elements or content-blocks — with typed wrappers, flat stream sync, and multiple serialization formats.

## What it is

A reactive tree model where every node has the same shape:

```typescript
interface TreeNode {
  id: string;                        // Snowflake ID (Crockford base32, 13 chars)
  type: string;                      // "session", "turn", "user_message", "tool_call", etc.
  props: Record<string, unknown>;    // type-specific properties
  content?: string;                  // text content
  children?: TreeNode[];             // nested entries
}
```

`TreeEntry` extends `BaseClass` to make it reactive — listeners fire on changes, propagating from children to parents via `bubbleUp()`.

## Why it exists

The `@statewalker/ai-agent` package represents conversation state as a flat `AgentMessage[]` array. This lacks structure (no hierarchy), has no reactive change propagation, and gives external consumers no way to subscribe to specific parts of the conversation. This package provides a structured, observable state model while keeping things simple.

Key design principle: **uniform nodes + typed wrappers**, like jQuery for DOM. All nodes are identical in shape. Wrappers (`SessionView`, `TurnView`, `MessageView`, etc.) add typed access on top.

## How to use

### Build a tree

```typescript
import { TreeEntry } from "@statewalker/ai-agent-state";

const session = new TreeEntry("session");
const turn = new TreeEntry("turn", { props: { turnNumber: 1 } });
const msg = new TreeEntry("user_message", { content: "Hello" });

session.addChild(turn);
turn.addChild(msg);
```

### Listen to changes

```typescript
session.onUpdate(() => {
  console.log("Something changed in the session tree");
});

// Any descendant change bubbles up to session
msg.content = "Updated";
msg.bubbleUp(); // session listener fires
```

### Traverse with visit()

```typescript
session.visit(
  (node) => {
    console.log(`${node.type}: ${node.content ?? ""}`);
    // return false to skip children
  },
  () => {
    // called after children (or immediately if skipped)
  },
);
```

### Clone / sync via flat streams

```typescript
import { toFlatStream, applyFlat } from "@statewalker/ai-agent-state";

// Clone a tree
const clone = applyFlat(undefined, toFlatStream(session));

// Incremental sync — only new + modified nodes
const lastKnownId = getLastId(clone);
// ... time passes, session gets new turns ...
applyFlat(clone, toFlatStream(session, lastKnownId));
```

### Serialize to JSON

```typescript
import { treeToJson, jsonToTree } from "@statewalker/ai-agent-state";

const json = treeToJson(session);  // { id, type, props, children: [...] }
const restored = jsonToTree(json); // fully wired TreeEntry tree
```

## Examples

### Agent conversation tree

```
session (id: 01HGX...)
├── turn (turnNumber: 1)
│   ├── user_message: "Read /tmp/data.json"
│   ├── agent_message: "Sure, let me read that."
│   └── tool_call (toolName: "read", callId: "c1")
│       ├── tool_request (args: {path: "/tmp/data.json"})
│       └── tool_response: "{\"name\": \"test\"}"
└── turn (turnNumber: 2)
    └── agent_message: "The file contains..."
```

### FlatTreeNode stream (for sync / markdown / events)

```typescript
// toFlatStream() emits nodes ordered by Snowflake ID:
[
  { id: "01HGX..001", type: "session" },
  { id: "01HGX..002", type: "turn", parentId: "01HGX..001", props: { turnNumber: 1 } },
  { id: "01HGX..003", type: "user_message", parentId: "01HGX..002", content: "Hello" },
  // ...
]
```

### Incremental sync between two trees

```typescript
// Tree 1 has 5 nodes. Tree 2 is a clone.
// Tree 1 gets a new turn + a modified message.

const sinceId = getLastId(tree2);           // checkpoint
const delta = toFlatStream(tree1, sinceId); // only new + modified
applyFlat(tree2, delta);                    // tree2 is now in sync
```

## Internals

### Architectural decisions

- **Uniform nodes**: All nodes share the same `TreeNode` shape. No class hierarchy for sessions, turns, messages. The `type` field discriminates. Typed access comes from wrappers (separate layer, not yet in this package version).
- **Dual serialization**: Structural JSON (`TreeNode` with nested `children`) for compact storage. Flat (`FlatTreeNode[]` with `parentId`) for streaming, sync, markdown, and event replay.
- **`bubbleUp()` propagation**: Simple recursive notify — child → parent → root. No batching or microtask coalescing. Consumers who need debounce add their own.
- **Explicit `updatedAt`**: Lives in `props`, set by callers on mutation. NOT auto-stamped in `notify()` — that would incorrectly stamp parents during `bubbleUp`.
- **`visit(begin, end)` as canonical traversal**: Separates traversal from output format. One mechanism for JSON, flat streams, markdown, and event replay.

### Snowflake IDs and ordering

IDs are Crockford base32 encoded Snowflake IDs from `@repo/ids`:

```
64-bit: [42-bit timestamp | 10-bit worker | 12-bit sequence]
     → Crockford base32, zero-padded to 13 chars
     → lexicographic string comparison = chronological order
```

This means `toFlatStream()` sorts by `id` string comparison — no numeric parsing needed. The `since` filter uses `id >= sinceId` for new nodes and `props.updatedAt >= extractTime(sinceId)` for modified old nodes.

### `applyFlat` semantics

- New `id` → create `TreeEntry`, wire to parent via `parentId`
- Existing `id` → merge `props` (Object.assign), replace `content`, call `notify()`
- Idempotent — applying the same stream twice is a no-op (no duplicate children)

### Constraints

- No content-blocks dependency in core — markdown serialization is a separate optional layer
- `parent` reference is a live object reference, excluded from all serialization formats
- `children` array is replaced (not mutated) on `addChild`/`removeChild` — change detection is reference equality

### Dependencies

- `@repo/ids` — Snowflake ID generation (Crockford base32)
- `@repo/shared` — `BaseClass` (reactive model foundation)
- Zero dependency on `@statewalker/content-blocks` (markdown layer is optional)

## License

MIT
