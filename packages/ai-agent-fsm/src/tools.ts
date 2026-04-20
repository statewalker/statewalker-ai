import type {
  AgentTool,
  ToolCallInfo,
  ToolContext,
  ToolResultInfo,
} from "./types.js";

export async function executeTool(
  tool: AgentTool,
  call: ToolCallInfo,
  signal: AbortSignal,
): Promise<ToolResultInfo> {
  const ctx: ToolContext = { toolCallId: call.toolCallId, signal };
  try {
    const output = await tool.execute(call.args, ctx);
    return {
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      output,
    };
  } catch (err) {
    return {
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      output: `Error: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}

export async function executeToolCalls(
  tools: AgentTool[],
  calls: ToolCallInfo[],
  signal: AbortSignal,
): Promise<ToolResultInfo[]> {
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const promises = calls.map((call) => {
    const tool = toolMap.get(call.toolName);
    if (!tool) {
      return Promise.resolve({
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: `Error: Unknown tool "${call.toolName}"`,
        isError: true,
      } satisfies ToolResultInfo);
    }
    return executeTool(tool, call, signal);
  });
  return Promise.all(promises);
}
