import { extractTime } from "@repo/ids";
import type { TreeEntry } from "./tree-entry.js";
import type { FlatTreeNode } from "./types.js";

/**
 * Emit a `FlatTreeNode` stream from a tree, ordered by id ascending
 * (Crockford base32 lexicographic = chronological).
 *
 * If `since` is provided (a Snowflake ID string), only emits:
 * - Nodes where `id >= since` (created at or after that point)
 * - Nodes where `props.updatedAt >= extractTime(since)` (modified since)
 */
export function* toFlatStream(
  root: TreeEntry,
  since?: string,
): Generator<FlatTreeNode> {
  const nodes: FlatTreeNode[] = [];
  collectFlat(root, undefined, nodes);
  nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  if (!since) {
    yield* nodes;
    return;
  }

  const sinceTime = extractTime(since);
  for (const node of nodes) {
    if (node.id >= since) {
      yield node;
    } else {
      const updatedAt = node.props.updatedAt;
      if (typeof updatedAt === "number" && updatedAt >= sinceTime) {
        yield node;
      }
    }
  }
}

function collectFlat(
  entry: TreeEntry,
  parentId: string | undefined,
  out: FlatTreeNode[],
): void {
  const node: FlatTreeNode = {
    id: entry.id,
    type: entry.type,
    props: { ...entry.props },
  };
  if (parentId !== undefined) {
    node.parentId = parentId;
  }
  if (entry.content !== undefined) {
    node.content = entry.content;
  }
  out.push(node);

  if (entry.children) {
    for (const child of entry.children) {
      collectFlat(child, entry.id, out);
    }
  }
}
