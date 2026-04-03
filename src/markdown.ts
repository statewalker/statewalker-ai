import type { ContentDocument, ContentSection } from "@repo/content-blocks";
import { parseDocument, serializeDocument } from "@repo/content-blocks/parser";
import { applyFlat } from "./apply-flat.js";
import { toFlatStream } from "./flat-stream.js";
import type { TreeNode } from "./tree-node.js";
import type { FlatTreeEntry, NodeFactory } from "./types.js";

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

/**
 * Deserialize a tree from markdown.
 */
export function markdownToTree(
  markdown: string,
  factory: NodeFactory,
): TreeNode {
  const doc = parseDocument(markdown);
  const nodes: FlatTreeEntry[] = [];

  if (doc.props?.id) {
    nodes.push(sectionPropsToFlat(doc.props));
  }

  for (const section of doc.content) {
    const rawProps = section.props ?? {};
    if (!rawProps.id) continue;

    const flat = sectionPropsToFlat(rawProps);
    const content =
      section.blocks.length > 0 ? section.blocks[0]?.content : undefined;
    if (content) flat.content = content;
    nodes.push(flat);
  }

  return applyFlat(undefined, nodes, factory);
}

function sectionPropsToFlat(
  rawProps: Record<string, string | undefined>,
): FlatTreeEntry {
  const id = rawProps.id as string;
  const parentId = rawProps.parentId;
  const props: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(rawProps)) {
    if (key === "id" || key === "parentId") continue;
    if (value === undefined) continue;
    props[key] = tryParseJson(value);
  }

  const flat: FlatTreeEntry = { id, props };
  if (parentId) flat.parentId = parentId;
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
