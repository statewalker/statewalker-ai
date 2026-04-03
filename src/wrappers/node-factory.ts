import { NodeType } from "../node-types.js";
import { TreeNode } from "../tree-node.js";
import type { NodeFactory, TreeEntry } from "../types.js";
import { Message } from "./message.js";
import { Session } from "./session.js";
import { ToolCall } from "./tool-call.js";
import { Turn } from "./turn.js";

/**
 * Create a node factory from a type → constructor index.
 * Unknown types fall back to plain TreeNode.
 */
export function newNodeFactory(
  index: Record<
    string,
    new (
      data: TreeEntry,
      factory: NodeFactory,
    ) => TreeNode
  >,
): NodeFactory {
  const factory: NodeFactory = (data: TreeEntry) => {
    const type = (data.props.type as string) ?? "message";
    const Ctor = index[type] ?? TreeNode;
    return new Ctor(data, factory);
  };
  return factory;
}

/**
 * Create the default agent node factory.
 * Maps known types to typed wrappers (Session, Turn, Message, ToolCall).
 */
export function createAgentNodeFactory(): NodeFactory {
  return newNodeFactory({
    [NodeType.session]: Session,
    [NodeType.turn]: Turn,
    [NodeType.userMessage]: Message,
    [NodeType.agentMessage]: Message,
    [NodeType.thinking]: Message,
    [NodeType.text]: Message,
    [NodeType.toolCall]: ToolCall,
  });
}
