/** Standard node type constants for agent conversations. */
export const NodeType = {
  session: "session",
  turn: "turn",
  userMessage: "user_message",
  agentMessage: "agent_message",
  thinking: "thinking",
  text: "text",
  toolCall: "tool_call",
  toolRequest: "tool_request",
  toolResponse: "tool_response",
  error: "error",
  inputRejected: "input_rejected",
} as const;
