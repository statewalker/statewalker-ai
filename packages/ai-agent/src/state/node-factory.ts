import { Message } from "./message.js";
import { NodeType } from "./node-types.js";
import { SessionState } from "./session-state.js";
import { ToolCall } from "./tool-call.js";
import type { TreeNode } from "./tree-node.js";
import { newNodeFactory } from "./tree-node-factory.js";
import type { NodeFactory, TreeEntry } from "./tree-types.js";
import { Turn } from "./turn.js";
import { TurnGroup } from "./turn-group.js";

const AGENT_TYPES: Record<string, new (data: TreeEntry, factory: NodeFactory) => TreeNode> = {
  [NodeType.session]: SessionState,
  [NodeType.turn]: Turn,
  [NodeType.turnGroup]: TurnGroup,
  [NodeType.userMessage]: Message,
  [NodeType.agentMessage]: Message,
  [NodeType.thinking]: Message,
  [NodeType.text]: Message,
  [NodeType.toolCall]: ToolCall,
};

/**
 * Create the default agent node factory.
 * Maps known agent types to typed wrappers (Session, Turn, Message, ToolCall).
 * Accepts additional type mappings that override or extend the defaults.
 */
export function createAgentNodeFactory(
  extra?: Record<string, new (data: TreeEntry, factory: NodeFactory) => TreeNode>,
): NodeFactory {
  return newNodeFactory(extra ? { ...AGENT_TYPES, ...extra } : AGENT_TYPES);
}
