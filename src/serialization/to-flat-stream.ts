import { extractTime } from "@repo/ids";
import type { TreeNode } from "../tree-node.js";
import type { FlatTreeEntry } from "../types.js";

/**
 * Emit a `FlatTreeEntry` stream from a tree in document order (depth-first
 * pre-order traversal). Document order guarantees that parents precede their
 * children and that siblings appear in their structural position — both
 * invariants required by `applyFlat` to reconstruct the tree correctly when
 * wrapper nodes (created later in time than the children they adopt) are
 * present.
 *
 * If `since` is provided (a Snowflake ID string), only emits:
 * - Nodes where `id >= since` (created at or after that point)
 * - Nodes where `updatedAt >= since time` (modified since that point)
 */
export function* toFlatStream(
  root: TreeNode,
  since?: string,
): Generator<FlatTreeEntry> {
  const nodes: TreeNode[] = [];
  collectNodes(root, nodes);

  if (!since) {
    for (const node of nodes) {
      yield nodeToFlat(node);
    }
    return;
  }

  const sinceTime = extractTime(since);
  for (const node of nodes) {
    if (node.id >= since) {
      // New node (created at or after the checkpoint)
      yield nodeToFlat(node);
    } else if (
      node.props.updatedAt !== undefined &&
      node.updatedAt.getTime() >= sinceTime
    ) {
      // Old node explicitly modified since the checkpoint
      yield nodeToFlat(node);
    }
  }
}

function collectNodes(node: TreeNode, out: TreeNode[]): void {
  out.push(node);
  for (const child of node.children) {
    collectNodes(child, out);
  }
}

function nodeToFlat(node: TreeNode): FlatTreeEntry {
  const flat: FlatTreeEntry = {
    id: node.id,
    props: { ...node.props },
  };
  if (node.parentId !== undefined) {
    flat.parentId = node.parentId;
  }
  if (node.content !== undefined) {
    flat.content = node.content;
  }
  return flat;
}
