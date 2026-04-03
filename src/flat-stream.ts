import { extractTime } from "@repo/ids";
import type { TreeEntry } from "./tree-entry.js";
import type { FlatTreeNode } from "./types.js";

/**
 * Emit a `FlatTreeNode` stream from a tree, ordered by id ascending
 * (Crockford base32 lexicographic = chronological).
 *
 * If `since` is provided (a Snowflake ID string), only emits:
 * - Nodes where `id >= since` (created at or after that point)
 * - Nodes where `updatedAt >= since time` (modified since that point)
 */
export function* toFlatStream(
  root: TreeEntry,
  since?: string,
): Generator<FlatTreeNode> {
  const entries: TreeEntry[] = [];
  collectEntries(root, entries);
  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  if (!since) {
    for (const entry of entries) {
      yield entryToFlat(entry);
    }
    return;
  }

  const sinceTime = extractTime(since);
  for (const entry of entries) {
    if (entry.id >= since) {
      yield entryToFlat(entry);
    } else if (entry.updatedAt.getTime() >= sinceTime) {
      yield entryToFlat(entry);
    }
  }
}

function collectEntries(entry: TreeEntry, out: TreeEntry[]): void {
  out.push(entry);
  if (entry.children) {
    for (const child of entry.children) {
      collectEntries(child, out);
    }
  }
}

function entryToFlat(entry: TreeEntry): FlatTreeNode {
  const node: FlatTreeNode = {
    id: entry.id,
    type: entry.type,
    props: { ...entry.props },
  };
  if (entry.parentId !== undefined) {
    node.parentId = entry.parentId;
  }
  if (entry.content !== undefined) {
    node.content = entry.content;
  }
  return node;
}
