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
 */
export type NodeFactory = (
  data: TreeEntry,
  registry: NodeRegistry,
) => import("./tree-node.js").TreeNode;

/**
 * Maps props.type → factory. Used to create typed wrappers during
 * child access, deserialization, and tree construction.
 */
export type NodeRegistry = Map<string, NodeFactory>;
