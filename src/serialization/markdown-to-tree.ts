import { parseDocument } from "@repo/content-blocks/parser";
import type { TreeNode } from "../tree-node.js";
import type { FlatTreeEntry, NodeFactory } from "../types.js";
import { applyFlat } from "./apply-flat.js";

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
    const raw =
      section.blocks.length > 0 ? section.blocks[0]?.content : undefined;
    if (raw) flat.content = stripCodeFence(raw);
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

const CODE_FENCE_RE = /^```[^\n]*\n([\s\S]*)\n```$/;

/** Strip a fenced code block wrapper, returning the inner content. */
function stripCodeFence(text: string): string {
  const m = CODE_FENCE_RE.exec(text);
  return m ? (m[1] as string) : text;
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
