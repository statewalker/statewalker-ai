import type { ContentDocument, ContentSection } from "@statewalker/content-blocks";
import { serializeDocument } from "@statewalker/content-blocks/parser";
import type { TreeNode } from "../tree-node.js";
import { toFlatStream } from "./to-flat-stream.js";

/**
 * Serialize a tree to markdown. Each node becomes a content-blocks section.
 *
 * `codeBlocks` optionally maps node types to code-fence languages.
 * Matching nodes get their content wrapped in fenced code blocks
 * for readability (e.g. `tool_request` → `` ```llm:tool-params ``).
 */
export function treeToMarkdown(root: TreeNode, codeBlocks?: Record<string, string>): string {
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

    let content = flat.content;
    if (content && codeBlocks) {
      const lang = codeBlocks[flat.props.type as string];
      if (lang) {
        content = `\`\`\`${lang}\n${content}\n\`\`\``;
      }
    }

    const section: ContentSection = {
      props,
      blocks: content ? [{ content }] : [],
    };
    sections.push(section);
  }

  const doc: ContentDocument = { content: sections };
  return serializeDocument(doc);
}
