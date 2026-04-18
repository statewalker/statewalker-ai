/** Classification of how a turn ended, derived from the AI SDK finishReason. */
export type TurnFinishKind =
  | "ok" // natural stop
  | "step-limit" // finishReason "tool-calls" after step budget exhausted
  | "length" // max_tokens or context window reached
  | "filtered" // content filter / safety
  | "error" // caught exception during streaming
  | "empty" // stream finished with no text, tool call, or error
  | "aborted" // abort signal fired
  | "unknown"; // finishReason we don't classify

/** Structured log messages yielded by AgentController.run and helpers. */
export type LogMessage =
  | { type: "text-delta"; turnId: string; text: string }
  | { type: "reasoning"; turnId: string; text: string }
  | {
      type: "tool-call";
      turnId: string;
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: "tool-result";
      turnId: string;
      toolCallId: string;
      toolName: string;
      result: unknown;
    }
  | {
      type: "tool-error";
      turnId: string;
      toolCallId: string;
      toolName: string;
      message: string;
    }
  | { type: "step-finish"; turnId: string; finishReason: string }
  | {
      type: "turn-finish";
      turnId: string;
      finishReason: string;
      kind: TurnFinishKind;
    }
  | { type: "error"; turnId: string; message: string };
