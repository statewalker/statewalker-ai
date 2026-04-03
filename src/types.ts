/**
 * Structural tree shape — for in-memory trees and compact JSON.
 * Parent-child relationships expressed via nested `children` arrays.
 */
export interface TreeNode {
  id: string;
  type: string;
  props: Record<string, unknown>;
  content?: string;
  children?: TreeNode[];
}

/**
 * Flat streamable shape — for serialization, events, sync.
 * Parent-child relationships expressed via `parentId` references.
 * Ordered by Snowflake ID (Crockford base32, lexicographic = chronological).
 */
export interface FlatTreeNode {
  id: string;
  type: string;
  parentId?: string;
  props: Record<string, unknown>;
  content?: string;
}
