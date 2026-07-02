import { tool } from "ai";
import { z } from "zod";
import type { SessionState } from "../state/session-state.js";

const todoSchema = z.object({
  id: z.string().describe("Stable identifier for the item within the list"),
  status: z.enum(["open", "done"]).describe("Whether the item still needs work"),
  text: z.string().describe("Short description of the task"),
});

/**
 * The worklist tool the autonomous loop reads. The model calls it to replace
 * the whole worklist; the {@link import("../runtime/loop-executor.js").LoopExecutor}
 * keeps driving while any item is open and stops when all are done.
 */
export function createWriteTodosTool(state: SessionState) {
  return tool({
    description:
      "Replace the current worklist with the provided list of todo items. " +
      "The agent continues working autonomously while any item is open and stops " +
      "when every item is done. Maintain this list to plan and track multi-step work.",
    inputSchema: z.object({
      todos: z
        .array(todoSchema)
        .describe("The complete new worklist; it replaces the previous list entirely"),
    }),
    execute: async ({ todos }) => {
      state.worklist = todos;
      const open = todos.filter((t) => t.status !== "done").length;
      return { count: todos.length, open };
    },
  });
}
