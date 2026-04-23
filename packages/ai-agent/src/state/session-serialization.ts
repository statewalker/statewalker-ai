import {
  markdownToTree,
  type NodeFactory,
  type TreeNode,
  treeToMarkdown,
} from "@statewalker/ai-agent-state";
import { NodeType } from "./node-types.js";

/** Maps node types to fenced code-block languages for markdown readability. */
const SESSION_CODE_BLOCKS: Record<string, string> = {
  [NodeType.toolRequest]: "llm:tool-params",
  [NodeType.toolResponse]: "llm:tool-response",
};

/** Serialize a session tree to markdown with tool content in code blocks. */
export function sessionToMarkdown(root: TreeNode): string {
  return treeToMarkdown(root, SESSION_CODE_BLOCKS);
}

/** Deserialize a session tree from markdown (auto-strips code fences). */
export function markdownToSession(markdown: string, factory: NodeFactory): TreeNode {
  return markdownToTree(markdown, factory);
}
