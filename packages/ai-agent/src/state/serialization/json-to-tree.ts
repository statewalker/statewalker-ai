import type { TreeNode } from "../tree-node.js";
import { wrapTree } from "../tree-node.js";
import type { NodeFactory, TreeEntry } from "../tree-types.js";

/**
 * Reconstruct a `TreeNode` tree from a structural `TreeEntry` JSON object.
 */
export function jsonToTree(json: TreeEntry, factory: NodeFactory): TreeNode {
  return wrapTree(buildData(json), factory);
}

function buildData(json: TreeEntry): TreeEntry {
  const entry: TreeEntry = {
    id: json.id,
    props: { ...json.props },
  };
  if (json.content !== undefined) {
    entry.content = json.content;
  }
  if (json.children) {
    entry.children = json.children.map(buildData);
  }
  return entry;
}
