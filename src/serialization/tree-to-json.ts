import type { TreeNode } from "../tree-node.js";
import type { TreeEntry } from "../types.js";

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
