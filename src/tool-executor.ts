import type { AgentTool, ToolContext, ToolOutput } from "./types.js";
import type { ToolCall } from "./wrappers/tool-call.js";
import type { Turn } from "./wrappers/turn.js";

export async function executeTools(
  turn: Turn,
  tools: AgentTool[],
  signal: AbortSignal,
): Promise<void> {
  const pending = turn.toolCalls.filter((tc) => !tc.response);
  if (pending.length === 0) return;

  await Promise.allSettled(
    pending.map((tc) => executeSingle(tc, tools, signal)),
  );
}

async function executeSingle(
  tc: ToolCall,
  tools: AgentTool[],
  signal: AbortSignal,
): Promise<void> {
  const tool = tools.find((t) => t.name === tc.toolName);
  if (!tool) {
    tc.addResponse(`Tool not found: ${tc.toolName}`, true);
    return;
  }

  const ctx: ToolContext = {
    toolCallId: tc.callId,
    toolName: tc.toolName,
    signal,
    onUpdate: (partial: ToolOutput) => tc.appendUpdate(partial.text),
    onProgress: (text: string) => {
      tc.progressText = text;
    },
  };

  try {
    const output = await tool.execute(tc.args, ctx);
    tc.addResponse(output.text, output.isError ?? false);
  } catch (err) {
    tc.addResponse(err instanceof Error ? err.message : String(err), true);
  }
}
