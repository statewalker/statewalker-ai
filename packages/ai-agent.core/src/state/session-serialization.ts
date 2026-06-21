import { applyFlat } from "./serialization/apply-flat.js";
import { deserialize } from "./serialization/deserialize.js";
import { type Node, serialize } from "./serialization/serialize.js";
import { toFlatStream } from "./serialization/to-flat-stream.js";
import type { TreeNode } from "./tree-node.js";
import type { FlatTreeEntry, NodeFactory } from "./tree-types.js";

/**
 * Serialize a session tree to markdown using the stream serializer. Each
 * `FlatTreeEntry` becomes one block; hierarchy (id/parentId) lives in props.
 */
export async function sessionToMarkdown(root: TreeNode): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of serialize(flatToNodes(toFlatStream(root)))) {
    chunks.push(chunk);
  }
  return chunks.join("");
}

/** Deserialize a session tree from stream-serializer markdown. */
export async function markdownToSession(markdown: string, factory: NodeFactory): Promise<TreeNode> {
  const flat: FlatTreeEntry[] = [];
  for await (const node of deserialize([markdown])) {
    flat.push(nodeToFlat(node));
  }
  return applyFlat(undefined, flat, factory);
}

function* flatToNodes(stream: Iterable<FlatTreeEntry>): Generator<Node> {
  for (const entry of stream) {
    const props: Record<string, string> = { id: entry.id };
    if (entry.parentId) props.parentId = entry.parentId;
    for (const [key, value] of Object.entries(entry.props)) {
      if (value === undefined) continue;
      props[key] = typeof value === "string" ? value : JSON.stringify(value);
    }
    yield { props, content: entry.content ?? "" };
  }
}

function nodeToFlat(node: Node): FlatTreeEntry {
  const { id, parentId, ...rest } = node.props;
  if (!id) {
    throw new Error("markdownToSession: node missing required `id` prop");
  }
  const props: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    props[key] = tryParseJson(value);
  }
  const flat: FlatTreeEntry = { id, props };
  if (parentId) flat.parentId = parentId;
  if (node.content !== "") flat.content = node.content;
  return flat;
}

function tryParseJson(value: string): unknown {
  if (
    value.startsWith("{") ||
    value.startsWith("[") ||
    value === "true" ||
    value === "false" ||
    value === "null"
  ) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  const num = Number(value);
  if (!Number.isNaN(num) && value.trim() !== "") {
    return num;
  }
  return value;
}
