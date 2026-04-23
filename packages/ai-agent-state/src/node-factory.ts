import { SnowflakeId } from "@statewalker/shared-ids";
import { TreeNode } from "./tree-node.js";
import type { NewEntryOptions, NodeFactory, TreeEntry } from "./types.js";

/**
 * Create a node factory from a type → constructor index.
 *
 * - Generates a Snowflake ID when `data.id` is not provided.
 * - Moves `data.type` into `props.type` (for `NewEntryOptions` input).
 * - Looks up the constructor by `props.type`; falls back to plain `TreeNode`.
 *
 * @param index  Map of `props.type` → constructor
 * @param idGen  Snowflake ID generator (default: shared instance)
 */
export function newNodeFactory(
  index: Record<string, new (data: TreeEntry, factory: NodeFactory) => TreeNode>,
  idGen: SnowflakeId = new SnowflakeId(),
): NodeFactory {
  const factory: NodeFactory = <
    N extends TreeNode = TreeNode,
    T extends TreeEntry | NewEntryOptions = TreeEntry | NewEntryOptions,
  >(
    data: T,
  ) => {
    const id = data.id ?? idGen.generate();
    const props: Record<string, unknown> = { ...data.props };
    if ("type" in data && data.type !== undefined) {
      props.type = data.type;
    }
    const entry: TreeEntry = { id, props };
    if (data.content !== undefined) {
      entry.content = data.content;
    }
    if ("children" in data && data.children) {
      entry.children = data.children as TreeEntry[];
    }

    const type = (props.type as string) ?? "message";
    const Ctor = index[type] ?? TreeNode;
    return new Ctor(entry, factory) as N;
  };
  return factory;
}
