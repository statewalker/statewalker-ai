import type { TreeNode } from "./tree-node";

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
 * one if not provided. `children` is optional and, when present, is adopted
 * verbatim (the factory keeps existing child ids intact).
 */
export interface NewEntryOptions {
  id?: string;
  type?: string;
  props?: Record<string, unknown>;
  content?: string;
  children?: TreeEntry[];
}

/**
 * Factory supplied to `TreeNode.groupChildren` — receives the slice of
 * adopted child entries (verbatim, with their existing ids) and returns
 * a description of the wrapper node that should adopt them.
 */
export type GroupWrapperFactory = (adoptedChildren: TreeEntry[]) => NewEntryOptions;

/**
 * Factory function that creates a TreeNode from either:
 * - `TreeEntry` (has `id`) — wrapping existing data (deserialization, sync)
 * - `NewEntryOptions` (no `id` required) — creating new nodes
 *
 * The factory generates a Snowflake ID if `id` is not provided,
 * and decides which subclass to instantiate based on type.
 */
export type NodeFactory = <
  N extends TreeNode = TreeNode,
  T extends TreeEntry | NewEntryOptions = TreeEntry | NewEntryOptions,
>(
  data: T,
) => N;
