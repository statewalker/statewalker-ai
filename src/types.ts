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
 * Factory function that creates a TreeNode wrapper for a given TreeEntry.
 * The factory decides which subclass to instantiate based on data (e.g., props.type).
 */
export type NodeFactory = (
  data: TreeEntry,
) => import("./tree-node.js").TreeNode;
