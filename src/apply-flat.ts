import { TreeEntry } from "./tree-entry.js";
import type { FlatTreeNode } from "./types.js";

/**
 * Build or update a `TreeEntry` tree from a `FlatTreeNode` stream.
 *
 * - If `root` is undefined, the first node creates the root.
 * - If a node's `id` exists in the tree, it is updated (merge props, replace content).
 * - If a node's `id` is new, a new `TreeEntry` is created and wired to its parent via `parentId`.
 *
 * Returns the root `TreeEntry`.
 */
export function applyFlat(
  root: TreeEntry | undefined,
  nodes: Iterable<FlatTreeNode>,
): TreeEntry {
  const index = new Map<string, TreeEntry>();

  // Index existing tree nodes if root provided
  if (root) {
    indexTree(root, index);
  }

  for (const flat of nodes) {
    const existing = index.get(flat.id);
    if (existing) {
      // Update existing node
      Object.assign(existing.props, flat.props);
      if (flat.content !== undefined) {
        existing.content = flat.content;
      }
      existing.notify();
    } else {
      // Create new node
      const entry = new TreeEntry({
        type: flat.type,
        id: flat.id,
        props: { ...flat.props },
        content: flat.content,
      });
      index.set(flat.id, entry);

      if (flat.parentId) {
        const parent = index.get(flat.parentId);
        if (parent) {
          parent.addChild(entry);
        }
      }

      if (!root) {
        root = entry;
      }
    }
  }

  if (!root) {
    throw new Error("applyFlat: empty stream, no root created");
  }
  return root;
}

function indexTree(entry: TreeEntry, map: Map<string, TreeEntry>): void {
  map.set(entry.id, entry);
  if (entry.children) {
    for (const child of entry.children) {
      indexTree(child, map);
    }
  }
}
