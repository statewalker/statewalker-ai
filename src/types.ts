/**
 * Pure data shape for tree nodes.
 * This is what gets serialized/deserialized.
 * `type` lives in `props` (e.g., props.type = "session").
 */
export interface TreeEntry {
  id: string;
  props: Record<string, unknown>;
  content?: string;
  children?: TreeEntry[];
}

/**
 * Flat streamable shape — for serialization, events, sync.
 * Parent-child relationships expressed via `parentId` references.
 */
export interface FlatTreeEntry {
  id: string;
  parentId?: string;
  props: Record<string, unknown>;
  content?: string;
}

/**
 * Options for creating a new tree node. `id` is optional — the factory generates
 * one if not provided.
 */
export interface NewEntryOptions {
  id?: string;
  type?: string;
  props?: Record<string, unknown>;
  content?: string;
}

/**
 * Factory function that creates a TreeNode from either:
 * - `TreeEntry` (has `id`) — wrapping existing data (deserialization, sync)
 * - `NewEntryOptions` (no `id` required) — creating new nodes
 *
 * The factory generates a Snowflake ID if `id` is not provided,
 * and decides which subclass to instantiate based on type.
 */
export type NodeFactory = (
  data: TreeEntry | NewEntryOptions,
) => import("./tree-node.js").TreeNode;
