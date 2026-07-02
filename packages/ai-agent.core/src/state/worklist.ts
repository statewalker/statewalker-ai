/**
 * One item on a session's worklist — the autonomous-continuation rail. A flat
 * list of these lives on {@link import("./session-state.js").SessionState} and
 * is maintained by the `write_todos` tool.
 */
export interface TodoItem {
  /** Stable identifier within the worklist. */
  id: string;
  /** Whether the item still needs work. */
  status: "open" | "done";
  /** Human-readable description of the task. */
  text: string;
}

/** The still-open items of a worklist. */
export function openTodos(items: TodoItem[]): TodoItem[] {
  return items.filter((i) => i.status !== "done");
}
