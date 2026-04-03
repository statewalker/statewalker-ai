import { SnowflakeId } from "@repo/ids";
import type { TreeNode } from "./tree-node.js";
import type { NodeFactory, TreeEntry } from "./types.js";

const defaultIdGen = new SnowflakeId();

/**
 * Create a new `TreeEntry` data object with a Snowflake ID.
 */
export function createEntry(
  options: {
    id?: string;
    type?: string;
    props?: Record<string, unknown>;
    content?: string;
    idGen?: SnowflakeId;
  } = {},
): TreeEntry {
  const id = options.id ?? (options.idGen ?? defaultIdGen).generate();
  const props: Record<string, unknown> = { ...options.props };
  if (options.type !== undefined) {
    props.type = options.type;
  }
  const entry: TreeEntry = { id, props };
  if (options.content !== undefined) {
    entry.content = options.content;
  }
  return entry;
}

/**
 * Wrap a `TreeEntry` data tree using a factory.
 */
export function wrapTree(data: TreeEntry, factory: NodeFactory): TreeNode {
  return factory(data);
}
