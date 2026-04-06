/** Structured log messages yielded by Session.runTurn / AgentController.handleTurn. */
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
  | { type: "step-finish"; turnId: string; finishReason: string }
  | { type: "error"; turnId: string; message: string };
