import type { TreeNode } from "../tree-node.js";
import { wrapTree } from "../tree-node.js";
import type { FlatTreeEntry, NodeFactory, TreeEntry } from "../types.js";

/**
 * Build or update a `TreeNode` tree from a `FlatTreeEntry` stream.
 *
 * - If `root` is undefined, the incoming stream must contain exactly one entry
 *   with no `parentId` (or a `parentId` not referencing any other entry) —
 *   that entry becomes the root.
 * - If a node's `id` already exists in the tree, it is updated (merge props,
 *   replace content).
 * - Entries whose parent is referenced later in the stream (e.g. a group
 *   wrapper written after its adopted children) are handled in a two-pass
 *   scheme: entries are buffered, then attached top-down once all are known.
 */
export function applyFlat(
  root: TreeNode | undefined,
  nodes: Iterable<FlatTreeEntry>,
  factory: NodeFactory,
): TreeNode {
  const nodeIndex = new Map<string, TreeNode>();
  if (root) {
    indexTree(root, nodeIndex);
  }

  const pending: FlatTreeEntry[] = [];
  for (const flat of nodes) {
    const existingNode = nodeIndex.get(flat.id);
    if (existingNode) {
      existingNode.update(flat.props, flat.content);
    } else {
      pending.push(flat);
    }
  }

  // Determine the root among the pending entries (if no pre-existing root).
  if (!root) {
    const idSet = new Set(pending.map((p) => p.id));
    const rootCandidates = pending.filter(
      (p) => !p.parentId || !idSet.has(p.parentId),
    );
    if (rootCandidates.length === 0) {
      throw new Error("applyFlat: no root candidate in stream");
    }
    const rootFlat = rootCandidates[0];
    if (!rootFlat) {
      throw new Error("applyFlat: root candidate is undefined");
    }
    const rootEntry: TreeEntry = { id: rootFlat.id, props: { ...rootFlat.props } };
    if (rootFlat.content !== undefined) rootEntry.content = rootFlat.content;
    root = wrapTree(rootEntry, factory);
    nodeIndex.set(rootFlat.id, root);
  }

  // Index children-by-parent for deterministic top-down attachment that
  // preserves the incoming stream's document order within each parent.
  const childrenByParent = new Map<string, FlatTreeEntry[]>();
  for (const flat of pending) {
    if (flat.id === root.id) continue;
    const pid = flat.parentId;
    if (!pid) continue;
    let bucket = childrenByParent.get(pid);
    if (!bucket) {
      bucket = [];
      childrenByParent.set(pid, bucket);
    }
    bucket.push(flat);
  }

  // Walk top-down from the root, attaching each parent's children in order.
  const queue: string[] = [root.id];
  while (queue.length > 0) {
    const parentId = queue.shift();
    if (parentId === undefined) break;
    const parentNode = nodeIndex.get(parentId);
    if (!parentNode) continue;
    const bucket = childrenByParent.get(parentId);
    if (!bucket) continue;
    for (const flat of bucket) {
      if (nodeIndex.has(flat.id)) continue;
      const entry: TreeEntry = { id: flat.id, props: { ...flat.props } };
      if (flat.content !== undefined) entry.content = flat.content;
      const childNode = parentNode.addChild(entry);
      nodeIndex.set(flat.id, childNode);
      queue.push(flat.id);
    }
  }

  return root;
}

function indexTree(node: TreeNode, nodeIndex: Map<string, TreeNode>): void {
  nodeIndex.set(node.id, node);
  for (const child of node.children) {
    indexTree(child, nodeIndex);
  }
}
