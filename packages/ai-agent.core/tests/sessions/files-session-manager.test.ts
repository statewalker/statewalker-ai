import { setTimeout as waitMs } from "node:timers/promises";
import { SnowflakeId } from "@statewalker/shared-ids";
import { tryReadText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { beforeEach, describe, expect, it } from "vitest";
import { FilesSessionManager } from "../../src/sessions/files-session-manager.js";
import {
  createAgentNodeFactory,
  NodeType,
  SessionState,
  ToolCall,
  Turn,
} from "../../src/state/index.js";

const factory = createAgentNodeFactory();
const idGen = new SnowflakeId();

function newSession(title?: string): { id: string; session: SessionState } {
  const id = idGen.generate();
  const session = factory<SessionState>({
    type: NodeType.session,
    props: title ? { title } : {},
  });
  return { id, session };
}

function buildPopulatedSession(): SessionState {
  const session = factory<SessionState>({ type: NodeType.session });
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
  let manager: FilesSessionManager;

  beforeEach(() => {
    files = new MemFilesApi();
    manager = new FilesSessionManager(files, "/sessions", factory);
  });

  describe("save inserts the index entry on first persist", () => {
    it("creates session folder with markdown file", async () => {
      const { id, session } = newSession("My session");
      await manager.save(id, session);
      expect(await files.exists(`/sessions/${id}/${id}.md`)).toBe(true);
    });

    it("updates the index with title from session.props", async () => {
      const { id, session } = newSession("Indexed session");
      await manager.save(id, session);
      const indexText = await tryReadText(files, "/sessions/index.json");
      expect(indexText).toBeTruthy();
      const index = JSON.parse(indexText as string);
      expect(index.sessions).toHaveLength(1);
      expect(index.sessions[0].id).toBe(id);
      expect(index.sessions[0].title).toBe("Indexed session");
    });

    it("inserts distinct ids for distinct sessions", async () => {
      const a = newSession("First chat");
      const b = newSession("Second chat");
      await manager.save(a.id, a.session);
      await manager.save(b.id, b.session);
      expect(a.id).not.toBe(b.id);
      const list = await manager.list();
      expect(list).toHaveLength(2);
    });
  });

  describe("save and load — round-trip", () => {
    it("preserves session tree structure", async () => {
      const id = idGen.generate();
      const session = buildPopulatedSession();

      await manager.save(id, session);
      const loaded = await manager.load(id);

      expect(loaded).toBeInstanceOf(SessionState);
      expect(loaded.turns).toHaveLength(1);

      const turn = loaded.turns[0] as Turn;
      expect(turn).toBeInstanceOf(Turn);
      expect(turn.model).toBe("claude-sonnet-4-20250514");
      expect(turn.stopReason).toBe("stop");
    });

    it("preserves user messages", async () => {
      const id = idGen.generate();
      const session = buildPopulatedSession();

      await manager.save(id, session);
      const loaded = await manager.load(id);

      const turn = loaded.turns[0] as Turn;
      expect(turn.messages).toHaveLength(3); // user + agent + agent2
      expect(turn.messages[0]?.text).toBe("Hello, what time is it?");
      expect(turn.messages[0]?.role).toBe("user");
    });

    it("preserves agent messages", async () => {
      const id = idGen.generate();
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
      const id = idGen.generate();
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
      const id = idGen.generate();
      const session = buildPopulatedSession();

      await manager.save(id, session);
      const loaded = await manager.load(id);

      const turn = loaded.turns[0] as Turn;
      expect(turn.usage).toEqual({ input: 100, output: 50 });
    });

    it("stores session as markdown file", async () => {
      const id = idGen.generate();
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
      const a = newSession("First");
      await manager.save(a.id, a.session);
      const b = newSession("Second");
      await manager.save(b.id, b.session);
      const c = newSession("Third");
      await manager.save(c.id, c.session);

      const list = await manager.list();
      expect(list).toHaveLength(3);
      // Most recently saved first
      expect(list[0]?.id).toBe(c.id);
      expect(list[0]?.title).toBe("Third");
    });

    it("returns empty array when no sessions", async () => {
      const list = await manager.list();
      expect(list).toEqual([]);
    });

    it("updates metadata on save", async () => {
      const { id, session } = newSession("Original title");
      await manager.save(id, session);
      session.update({ title: "Updated title" });

      await manager.save(id, session);

      const list = await manager.list();
      expect(list[0]?.title).toBe("Updated title");
    });
  });

  describe("exists", () => {
    it("returns true for existing session", async () => {
      const { id, session } = newSession();
      await manager.save(id, session);
      expect(await manager.exists(id)).toBe(true);
    });

    it("returns false for non-existing session", async () => {
      expect(await manager.exists("nonexistent")).toBe(false);
    });
  });

  describe("delete", () => {
    it("removes session folder and index entry", async () => {
      const { id, session } = newSession("To delete");
      await manager.save(id, session);
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
      const a = newSession("Keep");
      await manager.save(a.id, a.session);
      const b = newSession("Delete");
      await manager.save(b.id, b.session);

      await manager.delete(b.id);

      expect(await manager.exists(a.id)).toBe(true);
      expect(await manager.exists(b.id)).toBe(false);
      const list = await manager.list();
      expect(list).toHaveLength(1);
      expect(list[0]?.id).toBe(a.id);
    });
  });

  describe("index auto-rebuild", () => {
    it("rebuilds index from folder scan when index is missing", async () => {
      const a = newSession("SessionState A");
      await manager.save(a.id, a.session);
      const b = newSession("SessionState B");
      await manager.save(b.id, b.session);

      // Delete the index file directly
      await files.remove("/sessions/index.json");

      // list() should rebuild the index
      const list = await manager.list();
      expect(list).toHaveLength(2);
      const ids = list.map((s) => s.id);
      expect(ids).toContain(a.id);
      expect(ids).toContain(b.id);

      // Index file should be re-created
      expect(await files.exists("/sessions/index.json")).toBe(true);
    });
  });

  describe("multi-turn session", () => {
    it("round-trips a session with multiple turns", async () => {
      const id = idGen.generate();
      const session = factory<SessionState>({ type: NodeType.session });

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

  describe("per-session modelRef", () => {
    it("save then setModelRef round-trips the model selection", async () => {
      const { id, session } = newSession("Test");
      await manager.save(id, session);
      await manager.setModelRef(id, { connectionId: "openai", modelId: "gpt-4o" });
      const meta = await manager.getMetadata(id);
      expect(meta?.modelRef).toEqual({ connectionId: "openai", modelId: "gpt-4o" });
    });

    it("two sessions hold distinct modelRefs without cross-talk", async () => {
      const a = newSession("Session A");
      const b = newSession("Session B");
      await manager.save(a.id, a.session);
      await manager.save(b.id, b.session);
      await manager.setModelRef(a.id, { connectionId: "openai", modelId: "gpt-4o" });
      await manager.setModelRef(b.id, { connectionId: "google", modelId: "gemini-1.5-pro" });
      // Each session reads back its own selection; setting one never bleeds
      // into the other.
      expect((await manager.getMetadata(a.id))?.modelRef).toEqual({
        connectionId: "openai",
        modelId: "gpt-4o",
      });
      expect((await manager.getMetadata(b.id))?.modelRef).toEqual({
        connectionId: "google",
        modelId: "gemini-1.5-pro",
      });
    });

    it("save without setModelRef leaves the field undefined", async () => {
      const { id, session } = newSession("No model yet");
      await manager.save(id, session);
      const meta = await manager.getMetadata(id);
      expect(meta?.modelRef).toBeUndefined();
    });

    it("setModelRef updates an existing session's modelRef and bumps updatedAt", async () => {
      const { id, session } = newSession("Initial");
      await manager.save(id, session);
      const before = await manager.getMetadata(id);
      await waitMs(2);
      await manager.setModelRef(id, { connectionId: "google", modelId: "gemini-1.5-pro" });
      const after = await manager.getMetadata(id);
      expect(after?.modelRef).toEqual({
        connectionId: "google",
        modelId: "gemini-1.5-pro",
      });
      expect(after?.updatedAt).not.toBe(before?.updatedAt);
    });

    it("setModelRef(null) clears the modelRef", async () => {
      const { id, session } = newSession("Test");
      await manager.save(id, session);
      await manager.setModelRef(id, { connectionId: "openai", modelId: "gpt-4o" });
      await manager.setModelRef(id, null);
      const meta = await manager.getMetadata(id);
      expect(meta?.modelRef).toBeUndefined();
    });

    it("setModelRef with the same value is a no-op (updatedAt unchanged)", async () => {
      const { id, session } = newSession("Test");
      await manager.save(id, session);
      await manager.setModelRef(id, { connectionId: "openai", modelId: "gpt-4o" });
      const before = await manager.getMetadata(id);
      await waitMs(2);
      await manager.setModelRef(id, { connectionId: "openai", modelId: "gpt-4o" });
      const after = await manager.getMetadata(id);
      expect(after?.updatedAt).toBe(before?.updatedAt);
    });

    it("setModelRef on an unknown session id is a silent no-op", async () => {
      await manager.setModelRef("never-existed", {
        connectionId: "openai",
        modelId: "gpt-4o",
      });
      const meta = await manager.getMetadata("never-existed");
      expect(meta).toBeUndefined();
    });

    it("list preserves modelRef across reload", async () => {
      const { id, session } = newSession("Test");
      await manager.save(id, session);
      await manager.setModelRef(id, {
        connectionId: "anthropic",
        modelId: "claude-3-5-sonnet",
      });
      // Drop the in-memory manager; build a fresh one against the
      // same files to force a reload of index.json.
      const fresh = new FilesSessionManager(files, "/sessions", factory);
      const list = await fresh.list();
      expect(list.find((m) => m.id === id)?.modelRef).toEqual({
        connectionId: "anthropic",
        modelId: "claude-3-5-sonnet",
      });
    });
  });
});
