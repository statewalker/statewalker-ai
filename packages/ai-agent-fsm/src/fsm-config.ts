import type { FsmStateConfig } from "@statewalker/fsm";

export function createAgentFsmConfig(): FsmStateConfig {
  return {
    key: "agent",
    transitions: [
      ["", "prompt", "Generating"],
      ["Generating", "tool-calls", "Executing"],
      ["Generating", "complete", ""],
      ["Executing", "results", "Generating"],
      ["*", "error", ""],
      ["*", "abort", ""],
    ],
  };
}
