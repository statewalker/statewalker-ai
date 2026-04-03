import type { LlmMessage } from "@statewalker/ai/messages";
import { selectAll } from "./flatten.js";
import { executeTools } from "./tool-executor.js";
import type { AgentLoopConfig } from "./types.js";
import type { Message } from "./wrappers/message.js";
import { NodeType } from "./wrappers/node-types.js";

export async function agentLoop(config: AgentLoopConfig): Promise<void> {
  const { session, llm, model, tools, signal } = config;
  const select = config.select ?? selectAll;
  const turn = session.currentTurn;
  if (!turn) return;

  while (!signal?.aborted) {
    const messages: LlmMessage[] = [];
    for await (const msg of select(session)) {
      messages.push(msg);
    }

    let agentMsg: Message | undefined;
    let thinkingMsg: Message | undefined;
    let hasToolCalls = false;

    try {
      const stream = llm.streamChatCompletion({
        model,
        system: config.systemPrompt,
        messages,
        signal,
      });

      for await (const part of stream) {
        if (signal?.aborted) break;

        switch (part.type) {
          case "text-delta":
            if (!agentMsg) agentMsg = turn.addAgentMessage();
            agentMsg.appendDelta(part.textDelta);
            break;
          case "reasoning":
            if (!agentMsg) agentMsg = turn.addAgentMessage();
            if (!thinkingMsg) thinkingMsg = agentMsg.addThinkingBlock();
            thinkingMsg.appendDelta(part.textDelta);
            break;
          case "tool-call":
            turn.addToolCall(part.toolCallId, part.toolName, part.args);
            hasToolCalls = true;
            break;
          case "tool-result":
            turn.addToolResponse(part.toolCallId, part.result);
            break;
          case "step-finish":
            turn.stop(part.finishReason);
            break;
        }
      }
    } catch (err) {
      turn.addChild({
        type: NodeType.error,
        content: err instanceof Error ? err.message : String(err),
      });
      turn.stop("error");
      return;
    }

    if (signal?.aborted) {
      turn.stop("aborted");
      return;
    }

    turn.model = model;

    if (!hasToolCalls) return;

    await executeTools(turn, tools, signal ?? new AbortController().signal);

    agentMsg = undefined;
    thinkingMsg = undefined;
    hasToolCalls = false;
  }
}
