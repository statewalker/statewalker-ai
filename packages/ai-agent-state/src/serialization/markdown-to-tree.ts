import type { TreeNode } from "../tree-node.js";
import type { FlatTreeEntry, NodeFactory } from "../types.js";
import { applyFlat } from "./apply-flat.js";

/**
 * Deserialize a tree from markdown.
 *
 * Each `---`-separated section is a node. Properties are parsed from the
 * key: value block before the first empty line. Content is everything after
 * that empty line — kept as a raw string (not split by markdown headings).
 */
export function markdownToTree(markdown: string, factory: NodeFactory): TreeNode {
  const segments = markdown.split(/^-{3,}\s*$/m);
  const nodes: FlatTreeEntry[] = [];

  // First segment: frontmatter (if starts with empty line → skip segment[0], use segment[1])
  const hasFrontmatter = (segments[0] ?? "").trim() === "";
  const start = hasFrontmatter ? 1 : 0;

  for (let i = start; i < segments.length; i++) {
    const segment = segments[i];
    if (!segment?.trim()) continue;

    const flat = parseNodeSegment(segment);
    if (flat.id) nodes.push(flat);
  }

  return applyFlat(undefined, nodes, factory);
}

const CODE_FENCE_RE = /^```[^\n]*\n([\s\S]*?)\n```$/;

function stripCodeFence(text: string): string {
  const m = CODE_FENCE_RE.exec(text);
  return m ? (m[1] as string) : text;
}

function parseNodeSegment(segment: string): FlatTreeEntry {
  const trimmed = segment.replace(/^\s*\n/, "");

  // Find the first empty line — separates properties from content
  const emptyLineIdx = trimmed.search(/\n\s*\n/);

  let propsText: string;
  let contentText: string;

  if (emptyLineIdx === -1) {
    // No empty line — everything is properties (or a code block)
    propsText = trimmed.replace(/\s+$/, "");
    contentText = "";
  } else {
    propsText = trimmed.slice(0, emptyLineIdx);
    const afterEmpty = trimmed.indexOf("\n", emptyLineIdx + 1);
    contentText = afterEmpty >= 0 ? trimmed.slice(afterEmpty + 1).replace(/\s+$/, "") : "";
  }

  // Parse key: value properties
  const props: Record<string, unknown> = {};
  let id = "";
  let parentId: string | undefined;

  for (const line of propsText.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx <= 0) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key === "id") {
      id = value;
    } else if (key === "parentId") {
      parentId = value;
    } else {
      props[key] = tryParseJson(value);
    }
  }

  const flat: FlatTreeEntry = { id, props };
  if (parentId) flat.parentId = parentId;

  // Content: if it's a single code fence, strip it; otherwise keep raw text
  if (contentText) {
    flat.content = stripCodeFence(contentText);
  }

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
