import { escapeContent, serializeProps } from "./props.js";

export type Node = { props: Record<string, string>; content: string };

/**
 * Stream-serialize a sequence of `{props, content}` nodes to markdown chunks.
 *
 * Each emitted chunk is one complete block:
 *
 * ```
 * ---
 * key1=value1
 * key2=value2
 *
 * content
 * ```
 *
 * Concatenating all chunks yields the full document. Hierarchy is the
 * caller's responsibility — encode `id`/`parentId` (or whatever) in `props`.
 */
export async function* serialize(
  nodes: Iterable<Node> | AsyncIterable<Node>,
): AsyncIterable<string> {
  for await (const node of nodes) {
    const props = serializeProps(node.props);
    const content = escapeContent(node.content);
    yield `---\n${props}\n${content}${content.endsWith("\n") ? "" : "\n"}`;
  }
}
