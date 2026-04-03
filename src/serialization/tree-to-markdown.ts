import type { ContentDocument, ContentSection } from "@repo/content-blocks";
import { serializeDocument } from "@repo/content-blocks/parser";
import type { TreeNode } from "../tree-node.js";
import { toFlatStream } from "./to-flat-stream.js";

/**
 * Serialize a tree to markdown. Each node becomes a content-blocks section.
 */
export function treeToMarkdown(root: TreeNode): string {
  const sections: ContentSection[] = [];

  for (const flat of toFlatStream(root)) {
    const props: Record<string, string> = { id: flat.id };
    if (flat.parentId) {
      props.parentId = flat.parentId;
    }
    for (const [key, value] of Object.entries(flat.props)) {
      if (value === undefined) continue;
      props[key] = typeof value === "string" ? value : JSON.stringify(value);
    }

    const section: ContentSection = {
      props,
      blocks: flat.content ? [{ content: flat.content }] : [],
    };
    sections.push(section);
  }

  const doc: ContentDocument = { content: sections };
  return serializeDocument(doc);
}
