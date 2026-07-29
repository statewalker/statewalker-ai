import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { createAgentNodeFactory } from "../state/node-factory.js";
import { NodeType } from "../state/node-types.js";
import { sessionToMarkdown } from "../state/session-serialization.js";
import type { SessionState } from "../state/session-state.js";
import type { Turn } from "../state/turn.js";
import { FilesSessionManager } from "./files-session-manager.js";

const factory = createAgentNodeFactory();

/** A session tree with turns, messages, and a tool call (request + response). */
function buildSession(): SessionState {
  const session = factory({ type: NodeType.session }) as SessionState;
  session.title = "roundtrip session";

  const turn1 = session.addTurn({ turnNumber: 1 });
  turn1.addUserMessage("Read /tmp/data.json");
  turn1.addAgentMessage().appendDelta("Sure, reading it now.");
  turn1
    .addToolCall("call-001", "read_file", { path: "/tmp/data.json" })
    .addResponse('{"name":"test"}');
  turn1.stopReason = "tool-use";
  turn1.model = "claude-sonnet-4-20250514";

  const turn2 = session.addTurn({ turnNumber: 2 });
  turn2.addAgentMessage().appendDelta("The file contains a JSON object.");
  turn2.stopReason = "stop";

  return session;
}

describe("FilesSessionManager — save → load roundtrip over MemFilesApi", () => {
  it("reconstructs the session tree from disk with a fresh manager", async () => {
    const files = new MemFilesApi();
    const original = buildSession();

    // Save through one manager, then load with a FRESH manager on the SAME FilesApi
    // (proves the state survives a full reload, not an in-memory reference).
    await new FilesSessionManager(files).save(original.id, original);
    const reloaded = await new FilesSessionManager(files).load(original.id);

    // Deep structural equality via the canonical markdown serialization.
    expect(await sessionToMarkdown(reloaded)).toBe(await sessionToMarkdown(original));

    // Non-tautological spot checks on the reconstructed tree.
    expect(reloaded.id).toBe(original.id);
    expect(reloaded.title).toBe("roundtrip session");
    expect(reloaded.turns).toHaveLength(2);

    const t1 = reloaded.turns[0] as Turn;
    expect(t1.turnNumber).toBe(1);
    expect(t1.stopReason).toBe("tool-use");
    expect(t1.model).toBe("claude-sonnet-4-20250514");
    expect(t1.messages[0]?.text).toBe("Read /tmp/data.json");
    expect(t1.messages[1]?.text).toBe("Sure, reading it now.");
    expect(t1.toolCalls[0]?.toolName).toBe("read_file");
    expect(t1.toolCalls[0]?.result).toBe('{"name":"test"}');

    const t2 = reloaded.turns[1] as Turn;
    expect(t2.stopReason).toBe("stop");
    expect(t2.messages[0]?.text).toBe("The file contains a JSON object.");
  });

  it("lists the saved session in a fresh manager's index", async () => {
    const files = new MemFilesApi();
    const original = buildSession();
    await new FilesSessionManager(files).save(original.id, original);

    const listed = await new FilesSessionManager(files).list();
    expect(listed.map((s) => s.id)).toContain(original.id);
    expect(listed.find((s) => s.id === original.id)?.title).toBe("roundtrip session");
  });
});
