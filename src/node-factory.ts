import { SnowflakeId } from "@repo/ids";
import { TreeNode } from "./tree-node.js";
import type { NewEntryOptions, NodeFactory, TreeEntry } from "./types.js";

const defaultIdGen = new SnowflakeId();

/**
 * Ensure data has an `id`. If it's `NewEntryOptions` (no id), generate a Snowflake ID
 * and build a proper `TreeEntry`.
 */
function ensureEntry(data: TreeEntry | NewEntryOptions): TreeEntry {
  if ("id" in data && typeof data.id === "string") {
    return data as TreeEntry;
  }
  const opts = data as NewEntryOptions;
  const id = opts.id ?? defaultIdGen.generate();
  const props: Record<string, unknown> = { ...opts.props };
  if (opts.type !== undefined) {
    props.type = opts.type;
  }
  const entry: TreeEntry = { id, props };
  if (opts.content !== undefined) {
    entry.content = opts.content;
  }
  return entry;
}

/**
 * Create a node factory from a type → constructor index.
 * Handles ID generation for new nodes (no id in data).
 * Unknown types fall back to plain TreeNode.
 */
export function newNodeFactory(
  index: Record<
    string,
    new (
      data: TreeEntry,
      factory: NodeFactory,
    ) => TreeNode
  >,
): NodeFactory {
  const factory: NodeFactory = (
    data: TreeEntry | NewEntryOptions,
  ): TreeNode => {
    const entry = ensureEntry(data);
    const type = (entry.props.type as string) ?? "message";
    const Ctor = index[type] ?? TreeNode;
    return new Ctor(entry, factory);
  };
  return factory;
}
