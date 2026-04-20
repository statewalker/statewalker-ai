import { tryReadText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { beforeEach, describe, expect, it } from "vitest";
import { FilesSessionManager } from "../../src/sessions/files-session-manager.js";
import type { SessionManager } from "../../src/sessions/types.js";
import {
  createAgentNodeFactory,
  NodeType,
  Session,
  ToolCall,
  Turn,
} from "../../src/state/index.js";

const factory = createAgentNodeFactory();

function buildPopulatedSession(): Session {
  const session = factory<Session>({ type: NodeType.session });
  session.update({ title: "Test chat" });

  const turn = session.addTurn({ turnNumber: 1 });
  turn.addUserMessage("Hello, what time is it?");

  const agentMsg = turn.addAgentMessage();
  agentMsg.appendDelta("Let me check the time for you.");

  const tc = turn.addToolCall("call-001", "get_current_time", {});
  tc.addResponse(JSON.stringify({ time: "2026-04-06T13:20:00Z" }));

  // Second agent message after tool call
  const agentMsg2 = turn.addAgentMessage();
  agentMsg2.appendDelta("It's 1:20 PM UTC.");

  turn.model = "claude-sonnet-4-20250514";
  turn.stopReason = "stop";
  turn.usage = { input: 100, output: 50 };

  return session;
}

describe("FilesSessionManager", () => {
  let files: MemFilesApi;
  let manager: SessionManager;

  beforeEach(() => {
    files = new MemFilesApi();
    manager = new FilesSessionManager(files, "/", factory);
  });

  describe("create", () => {
    it("creates a session and returns a unique ID", async () => {
      const id1 = await manager.create("First chat");
      const id2 = await manager.create("Second chat");
      expect(id1).toBeTruthy();
      expect(id2).toBeTruthy();
      expect(id1).not.toBe(id2);
    });

    it("creates session folder with markdown file", async () => {
      const id = await manager.create("My session");
      expect(await files.exists(`/sessions/${id}/${id}.md`)).toBe(true);
    });

    it("updates the index", async () => {
      const id = await manager.create("Indexed session");
      const indexText = await tryReadText(files, "/sessions/index.json");
      expect(indexText).toBeTruthy();
      const index = JSON.parse(indexText as string);
      expect(index.sessions).toHaveLength(1);
      expect(index.sessions[0].id).toBe(id);
      expect(index.sessions[0].title).toBe("Indexed session");
    });
  });

  describe("save and load — round-trip", () => {
    it("preserves session tree structure", async () => {
      const id = await manager.create("Round-trip test");
      const session = buildPopulatedSession();

      await manager.save(id, session);
      const loaded = await manager.load(id);

      expect(loaded).toBeInstanceOf(Session);
      expect(loaded.turns).toHaveLength(1);

      const turn = loaded.turns[0] as Turn;
      expect(turn).toBeInstanceOf(Turn);
      expect(turn.model).toBe("claude-sonnet-4-20250514");
      expect(turn.stopReason).toBe("stop");
    });

    it("preserves user messages", async () => {
      const id = await manager.create();
      const session = buildPopulatedSession();

      await manager.save(id, session);
      const loaded = await manager.load(id);

      const turn = loaded.turns[0] as Turn;
      expect(turn.messages).toHaveLength(3); // user + agent + agent2
      expect(turn.messages[0]?.text).toBe("Hello, what time is it?");
      expect(turn.messages[0]?.role).toBe("user");
    });

    it("preserves agent messages", async () => {
      const id = await manager.create();
      const session = buildPopulatedSession();

      await manager.save(id, session);
      const loaded = await manager.load(id);

      const turn = loaded.turns[0] as Turn;
      const agentMsgs = turn.messages.filter((m) => m.role === "assistant");
      expect(agentMsgs).toHaveLength(2);
      expect(agentMsgs[0]?.text).toBe("Let me check the time for you.");
      expect(agentMsgs[1]?.text).toBe("It's 1:20 PM UTC.");
    });

    it("preserves tool calls", async () => {
      const id = await manager.create();
      const session = buildPopulatedSession();

      await manager.save(id, session);
      const loaded = await manager.load(id);

      const turn = loaded.turns[0] as Turn;
      expect(turn.toolCalls).toHaveLength(1);
      const tc = turn.toolCalls[0] as ToolCall;
      expect(tc).toBeInstanceOf(ToolCall);
      expect(tc.callId).toBe("call-001");
      expect(tc.toolName).toBe("get_current_time");
      expect(tc.result).toContain("2026-04-06T13:20:00Z");
    });

    it("preserves usage metadata", async () => {
      const id = await manager.create();
      const session = buildPopulatedSession();

      await manager.save(id, session);
      const loaded = await manager.load(id);

      const turn = loaded.turns[0] as Turn;
      expect(turn.usage).toEqual({ input: 100, output: 50 });
    });

    it("stores session as markdown file", async () => {
      const id = await manager.create();
      const session = buildPopulatedSession();

      await manager.save(id, session);

      const mdText = await tryReadText(files, `/sessions/${id}/${id}.md`);
      expect(mdText).toBeTruthy();
      expect(mdText).toContain("Hello, what time is it?");
      expect(mdText).toContain("Let me check the time for you.");
    });
  });

  describe("list", () => {
    it("returns all sessions sorted by updatedAt desc", async () => {
      await manager.create("First");
      await manager.create("Second");
      const id3 = await manager.create("Third");

      const list = await manager.list();
      expect(list).toHaveLength(3);
      // Most recently created first
      expect(list[0]?.id).toBe(id3);
      expect(list[0]?.title).toBe("Third");
    });

    it("returns empty array when no sessions", async () => {
      const list = await manager.list();
      expect(list).toEqual([]);
    });

    it("updates metadata on save", async () => {
      const id = await manager.create("Original title");
      const session = buildPopulatedSession();
      session.update({ title: "Updated title" });

      await manager.save(id, session);

      const list = await manager.list();
      expect(list[0]?.title).toBe("Updated title");
    });
  });

  describe("exists", () => {
    it("returns true for existing session", async () => {
      const id = await manager.create();
      expect(await manager.exists(id)).toBe(true);
    });

    it("returns false for non-existing session", async () => {
      expect(await manager.exists("nonexistent")).toBe(false);
    });
  });

  describe("delete", () => {
    it("removes session folder and index entry", async () => {
      const id = await manager.create("To delete");
      expect(await manager.exists(id)).toBe(true);

      const result = await manager.delete(id);
      expect(result).toBe(true);
      expect(await manager.exists(id)).toBe(false);

      const list = await manager.list();
      expect(list).toHaveLength(0);
    });

    it("returns false for non-existing session", async () => {
      expect(await manager.delete("nope")).toBe(false);
    });

    it("does not affect other sessions", async () => {
      const id1 = await manager.create("Keep");
      const id2 = await manager.create("Delete");

      await manager.delete(id2);

      expect(await manager.exists(id1)).toBe(true);
      expect(await manager.exists(id2)).toBe(false);
      const list = await manager.list();
      expect(list).toHaveLength(1);
      expect(list[0]?.id).toBe(id1);
    });
  });

  describe("index auto-rebuild", () => {
    it("rebuilds index from folder scan when index is missing", async () => {
      // Create some sessions (which writes the index)
      const id1 = await manager.create("Session A");
      const id2 = await manager.create("Session B");

      // Delete the index file directly
      await files.remove("/sessions/index.json");

      // list() should rebuild the index
      const list = await manager.list();
      expect(list).toHaveLength(2);
      const ids = list.map((s) => s.id);
      expect(ids).toContain(id1);
      expect(ids).toContain(id2);

      // Index file should be re-created
      expect(await files.exists("/sessions/index.json")).toBe(true);
    });
  });

  describe("multi-turn session", () => {
    it("round-trips a session with multiple turns", async () => {
      const id = await manager.create();
      const session = factory<Session>({ type: NodeType.session });

      // Turn 1
      const turn1 = session.addTurn({ turnNumber: 1 });
      turn1.addUserMessage("First question");
      const msg1 = turn1.addAgentMessage();
      msg1.appendDelta("First answer");
      turn1.stopReason = "stop";

      // Turn 2
      const turn2 = session.addTurn({ turnNumber: 2 });
      turn2.addUserMessage("Follow-up");
      const msg2 = turn2.addAgentMessage();
      msg2.appendDelta("Second answer");
      turn2.stopReason = "stop";

      await manager.save(id, session);
      const loaded = await manager.load(id);

      expect(loaded.turns).toHaveLength(2);
      expect(loaded.turns[0]?.messages[0]?.text).toBe("First question");
      expect(loaded.turns[0]?.messages[1]?.text).toBe("First answer");
      expect(loaded.turns[1]?.messages[0]?.text).toBe("Follow-up");
      expect(loaded.turns[1]?.messages[1]?.text).toBe("Second answer");
    });
  });
});
