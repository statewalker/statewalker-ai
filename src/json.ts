import { type TreeNode, wrapTree } from "./tree-node.js";
import type { NodeFactory, TreeEntry } from "./types.js";

/**
 * Serialize a `TreeNode` tree to a structural `TreeEntry` JSON object.
 */
export function treeToJson(root: TreeNode): TreeEntry {
  const stack: TreeEntry[] = [];
  let result: TreeEntry | undefined;

  root.visit(
    (entry): undefined => {
      const json: TreeEntry = {
        id: entry.id,
        props: { ...entry.props },
      };
      if (entry.content !== undefined) {
        json.content = entry.content;
      }

      const parent = stack[stack.length - 1];
      if (parent) {
        parent.children ??= [];
        parent.children.push(json);
      } else {
        result = json;
      }
      stack.push(json);
    },
    () => {
      stack.pop();
    },
  );

  if (!result) {
    throw new Error("treeToJson: empty tree");
  }
  return result;
}

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
