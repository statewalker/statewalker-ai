import type { LanguageModelUsage, TextStreamPart, ToolSet } from "ai";
import type { OpenAIChatCompletionChunk } from "../openai-types.js";
import { toOpenAIFinishReason } from "./finish-reason.js";
import { toOpenAIUsage } from "./usage.js";

export interface ChatStreamContext {
  id: string;
  created: number;
  model: string;
}

const emptyChunk = (
  ctx: ChatStreamContext,
  finish_reason: string | null = null,
): OpenAIChatCompletionChunk => ({
  id: ctx.id,
  object: "chat.completion.chunk",
  created: ctx.created,
  model: ctx.model,
  choices: [{ index: 0, delta: {}, finish_reason }],
});

interface ToolCallTrack {
  index: number;
  id: string;
  name: string;
  emittedHead: boolean;
}

export class ChatStreamEmitter {
  private toolByPartId = new Map<string, ToolCallTrack>();
  private nextToolIndex = 0;
  private firstContentEmitted = false;

  constructor(private readonly ctx: ChatStreamContext) {}

  *handle(part: TextStreamPart<ToolSet>): Generator<OpenAIChatCompletionChunk> {
    switch (part.type) {
      case "text-delta": {
        const chunk = emptyChunk(this.ctx);
        chunk.choices[0]!.delta = this.firstContentEmitted
          ? { content: part.text }
          : { role: "assistant", content: part.text };
        this.firstContentEmitted = true;
        yield chunk;
        return;
      }
      case "tool-input-start": {
        const tc: ToolCallTrack = {
          index: this.nextToolIndex++,
          id: part.id,
          name: part.toolName,
          emittedHead: true,
        };
        this.toolByPartId.set(part.id, tc);
        const chunk = emptyChunk(this.ctx);
        chunk.choices[0]!.delta = {
          role: "assistant",
          tool_calls: [
            {
              index: tc.index,
              id: tc.id,
              type: "function",
              function: { name: tc.name, arguments: "" },
            },
          ],
        };
        yield chunk;
        return;
      }
      case "tool-input-delta": {
        const tc = this.toolByPartId.get(part.id);
        if (!tc) return;
        const chunk = emptyChunk(this.ctx);
        chunk.choices[0]!.delta = {
          tool_calls: [
            {
              index: tc.index,
              function: { arguments: part.delta },
            },
          ],
        };
        yield chunk;
        return;
      }
      case "tool-call": {
        // Final assembled tool call; if no streaming deltas preceded it,
        // emit a single chunk carrying the whole arguments JSON.
        if (this.toolByPartId.has(part.toolCallId)) return;
        const index = this.nextToolIndex++;
        const tc: ToolCallTrack = {
          index,
          id: part.toolCallId,
          name: part.toolName,
          emittedHead: true,
        };
        this.toolByPartId.set(part.toolCallId, tc);
        const args = JSON.stringify((part as { input?: unknown }).input ?? {});
        const chunk = emptyChunk(this.ctx);
        chunk.choices[0]!.delta = {
          role: "assistant",
          tool_calls: [
            {
              index,
              id: part.toolCallId,
              type: "function",
              function: { name: part.toolName, arguments: args },
            },
          ],
        };
        yield chunk;
        return;
      }
      case "finish": {
        const chunk = emptyChunk(this.ctx, toOpenAIFinishReason(part.finishReason));
        const usage = toOpenAIUsage(part.totalUsage as LanguageModelUsage);
        if (usage) chunk.usage = usage;
        yield chunk;
        return;
      }
      default:
        return;
    }
  }
}
