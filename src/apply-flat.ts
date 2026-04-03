import type { TreeNode } from "./tree-node.js";
import { wrapTree } from "./tree-node.js";
import type { FlatTreeEntry, NodeFactory, TreeEntry } from "./types.js";

/**
 * Build or update a `TreeNode` tree from a `FlatTreeEntry` stream.
 *
 * - If `root` is undefined, the first node creates the root.
 * - If a node's `id` exists, it is updated (merge props, replace content).
 * - If a node's `id` is new, a new node is created and wired via `parentId`.
 */
export function applyFlat(
  root: TreeNode | undefined,
  nodes: Iterable<FlatTreeEntry>,
  factory: NodeFactory,
): TreeNode {
  const dataIndex = new Map<string, TreeEntry>();
  const nodeIndex = new Map<string, TreeNode>();

  if (root) {
    indexTree(root, dataIndex, nodeIndex);
  }

  for (const flat of nodes) {
    const existingNode = nodeIndex.get(flat.id);
    if (existingNode) {
      existingNode.update(flat.props, flat.content);
    } else {
      const entry: TreeEntry = {
        id: flat.id,
        props: { ...flat.props },
      };
      if (flat.content !== undefined) {
        entry.content = flat.content;
      }
      dataIndex.set(flat.id, entry);

      if (flat.parentId) {
        const parentNode = nodeIndex.get(flat.parentId);
        if (parentNode) {
          const child = parentNode.addChild(entry);
          nodeIndex.set(flat.id, child);
          continue;
        }
      }

      if (!root) {
        root = wrapTree(entry, factory);
        nodeIndex.set(flat.id, root);
      }
    }
  }

  if (!root) {
    throw new Error("applyFlat: empty stream, no root created");
  }
  return root;
}

function indexTree(
  node: TreeNode,
  dataIndex: Map<string, TreeEntry>,
  nodeIndex: Map<string, TreeNode>,
): void {
  dataIndex.set(node.id, node.data);
  nodeIndex.set(node.id, node);
  for (const child of node.children) {
    indexTree(child, dataIndex, nodeIndex);
  }
}
