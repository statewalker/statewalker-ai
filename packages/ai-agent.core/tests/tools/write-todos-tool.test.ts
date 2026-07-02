import { describe, expect, it } from "vitest";
import { createAgentNodeFactory } from "../../src/state/node-factory.js";
import { NodeType } from "../../src/state/node-types.js";
import type { SessionState } from "../../src/state/session-state.js";
import { createWriteTodosTool } from "../../src/tools/write-todos-tool.js";

function newState(): SessionState {
  const factory = createAgentNodeFactory();
  return factory<SessionState>({ type: NodeType.session, id: "s1", props: {} });
}

const toolOpts = { toolCallId: "call-1", messages: [] } as never;

describe("write_todos tool", () => {
  it("replaces the session worklist with the provided items", async () => {
    const state = newState();
    const wtool = createWriteTodosTool(state);
    const todos = [
      { id: "1", status: "open" as const, text: "step one" },
      { id: "2", status: "done" as const, text: "step two" },
    ];

    const result = await wtool.execute?.({ todos }, toolOpts);

    expect(state.worklist).toEqual(todos);
    expect(result).toEqual({ count: 2, open: 1 });
  });

  it("overwrites a prior worklist", async () => {
    const state = newState();
    state.worklist = [{ id: "old", status: "open", text: "stale" }];
    const wtool = createWriteTodosTool(state);

    await wtool.execute?.({ todos: [{ id: "new", status: "open", text: "fresh" }] }, toolOpts);

    expect(state.worklist).toEqual([{ id: "new", status: "open", text: "fresh" }]);
  });
});
