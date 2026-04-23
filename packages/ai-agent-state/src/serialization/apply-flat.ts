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

  // Index pending children by their (pending) parent id. A pending entry's
  // parent may already exist in the live tree (delta-sync case) or may be
  // another pending entry (a wrapper written after its adopted children in
  // the same batch).
  const childrenByParent = new Map<string | undefined, FlatTreeEntry[]>();
  for (const flat of pending) {
    const pid = flat.parentId;
    let bucket = childrenByParent.get(pid);
    if (!bucket) {
      bucket = [];
      childrenByParent.set(pid, bucket);
    }
    bucket.push(flat);
  }

  // If no pre-existing root, the stream must supply one.
  if (!root) {
    const rootless = childrenByParent.get(undefined) ?? [];
    // Also treat pending entries whose `parentId` is not resolvable as roots.
    const pendingIds = new Set(pending.map((p) => p.id));
    const orphans = pending.filter((p) => p.parentId !== undefined && !pendingIds.has(p.parentId));
    const rootFlat = rootless[0] ?? orphans[0];
    if (!rootFlat) {
      throw new Error("applyFlat: no root candidate in stream");
    }
    const rootEntry: TreeEntry = {
      id: rootFlat.id,
      props: { ...rootFlat.props },
    };
    if (rootFlat.content !== undefined) rootEntry.content = rootFlat.content;
    root = wrapTree(rootEntry, factory);
    nodeIndex.set(rootFlat.id, root);
  }

  // Walk top-down: for each parent that has resolvable pending children,
  // attach them in stream order. Seed the queue with every parent id that
  // already exists in `nodeIndex` (root + everything pre-existing in the
  // live tree) — so children whose parent lives in the existing tree
  // attach on the first pass.
  const queue: string[] = Array.from(nodeIndex.keys());
  const attached = new Set<string>();
  for (const n of nodeIndex.values()) attached.add(n.id);

  while (queue.length > 0) {
    const parentId = queue.shift();
    if (parentId === undefined) break;
    const parentNode = nodeIndex.get(parentId);
    if (!parentNode) continue;
    const bucket = childrenByParent.get(parentId);
    if (!bucket) continue;
    for (const flat of bucket) {
      if (attached.has(flat.id)) continue;
      const entry: TreeEntry = { id: flat.id, props: { ...flat.props } };
      if (flat.content !== undefined) entry.content = flat.content;
      const childNode = parentNode.addChild(entry);
      nodeIndex.set(flat.id, childNode);
      attached.add(flat.id);
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
