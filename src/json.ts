import { TreeEntry } from "./tree-entry.js";
import type { TreeNode } from "./types.js";

/**
 * Serialize a `TreeEntry` tree to a structural `TreeNode` JSON object
 * with nested `children` arrays.
 */
export function treeToJson(root: TreeEntry): TreeNode {
  const stack: TreeNode[] = [];
  let result: TreeNode | undefined;

  root.visit(
    (node): undefined => {
      const json: TreeNode = {
        id: node.id,
        type: node.type,
        props: { ...node.props },
      };
      if (node.content !== undefined) {
        json.content = node.content;
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
 * Reconstruct a `TreeEntry` tree from a structural `TreeNode` JSON object.
 * Preserves original IDs. Wires `parent` references via `addChild`.
 */
export function jsonToTree(json: TreeNode): TreeEntry {
  const entry = new TreeEntry(json.type, {
    id: json.id,
    props: { ...json.props },
    content: json.content,
  });

  if (json.children) {
    for (const child of json.children) {
      entry.addChild(jsonToTree(child));
    }
  }

  return entry;
}
