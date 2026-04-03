/**
 * Markdown serialization: every tree node becomes a content-blocks section.
 * Uses the flat format — parentId in props, ordered by Snowflake ID.
 *
 * Requires @repo/content-blocks (optional dependency).
 */

import type { ContentDocument, ContentSection } from "@repo/content-blocks";
import { parseDocument, serializeDocument } from "@repo/content-blocks/parser";
import { applyFlat } from "./apply-flat.js";
import { toFlatStream } from "./flat-stream.js";
import type { TreeEntry } from "./tree-entry.js";
import type { FlatTreeNode } from "./types.js";

/**
 * Serialize a tree to markdown. Each node becomes a content-blocks section
 * with id, type, parentId in props. Content goes to section block content.
 */
export function treeToMarkdown(root: TreeEntry): string {
  const sections: ContentSection[] = [];

  for (const flat of toFlatStream(root)) {
    const props: Record<string, string> = {
      id: flat.id,
      type: flat.type,
    };
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
 * Deserialize a tree from markdown. Parses sections into FlatTreeNode items,
 * then reconstructs the tree via applyFlat.
 */
export function markdownToTree(markdown: string): TreeEntry {
  const doc = parseDocument(markdown);
  const nodes: FlatTreeNode[] = [];

  // Document frontmatter becomes the root node
  if (doc.props?.id && doc.props?.type) {
    nodes.push(sectionPropsToFlat(doc.props));
  }

  // Each section becomes a child node
  for (const section of doc.content) {
    const rawProps = section.props ?? {};
    if (!rawProps.id || !rawProps.type) continue;

    const flat = sectionPropsToFlat(rawProps);
    const content =
      section.blocks.length > 0 ? section.blocks[0]?.content : undefined;
    if (content) flat.content = content;
    nodes.push(flat);
  }

  return applyFlat(undefined, nodes);
}

function sectionPropsToFlat(
  rawProps: Record<string, string | undefined>,
): FlatTreeNode {
  const id = rawProps.id as string;
  const type = rawProps.type as string;
  const parentId = rawProps.parentId;
  const props: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(rawProps)) {
    if (key === "id" || key === "type" || key === "parentId") continue;
    if (value === undefined) continue;
    props[key] = tryParseJson(value);
  }

  const flat: FlatTreeNode = { id, type, props };
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
