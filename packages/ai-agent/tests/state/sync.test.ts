import { describe, expect, it } from "vitest";
import {
  createAgentNodeFactory,
  Message,
  NodeType,
  SessionState,
  ToolCall,
  Turn,
} from "../../src/state/index.js";
import { applyFlat, toFlatStream, treeToJson } from "../../src/state/serialization/index.js";

const factory = createAgentNodeFactory();

describe("Live sync: session1 → session2 via FlatTreeEntry stream", () => {
  it("replicates a complex interleaved conversation", () => {
    // ── Create session1 (empty) ──────────────────────────────
    const session1 = factory({ type: NodeType.session }) as SessionState;

    // ── Create session2 as a copy of session1 ────────────────
    const session2 = applyFlat(undefined, toFlatStream(session1), factory) as SessionState;

    // ── Subscribe session2 to session1 updates ───────────────
    let lastSyncId = session2.id;

    function sync() {
      const delta = toFlatStream(session1, lastSyncId);
      applyFlat(session2, delta, factory);
      let maxId = lastSyncId;
      session1.visit((e) => {
        if (e.id > maxId) maxId = e.id;
        return undefined;
      });
      lastSyncId = maxId;
    }

    // ── Turn 1: user asks a question ─────────────────────────
    const turn1 = session1.addTurn({ turnNumber: 1 });
    turn1.addUserMessage("What files are in /tmp?");
    sync();

    // ── Turn 1: agent starts responding with thinking + text ─
    const agentMsg1 = turn1.addAgentMessage();
    const thinking1 = agentMsg1.addThinkingBlock();
    thinking1.appendDelta("I should list the directory contents.");
    agentMsg1.appendDelta("Let me check that for you.");
    sync();

    // ── Turn 1: agent makes a tool call ──────────────────────
    const tc1 = turn1.addToolCall("call-001", "list_files", {
      path: "/tmp",
    });
    sync();

    // ── Turn 1: tool response arrives ────────────────────────
    tc1.addResponse("data.json\nconfig.yaml\nREADME.md");
    turn1.stopReason = "tool-use";
    turn1.model = "claude-sonnet-4-20250514";
    turn1.usage = { input: 150, output: 80, cacheRead: 20 };
    sync();

    // ── Turn 2: agent summarizes (interleaved with user steering) ──
    const turn2 = session1.addTurn({ turnNumber: 2 });
    const agentMsg2 = turn2.addAgentMessage();
    agentMsg2.appendDelta("There are 3 files: ");
    sync();

    // ── User steering mid-stream ─────────────────────────────
    turn2.addUserMessage("Also check /var/log");
    sync();

    // ── Agent continues + second tool call ───────────────────
    agentMsg2.appendDelta("data.json, config.yaml, README.md.");
    const tc2 = turn2.addToolCall("call-002", "list_files", {
      path: "/var/log",
    });
    sync();

    // ── Second tool response with error ──────────────────────
    tc2.addResponse("Permission denied", true);
    tc2.progressText = "Checking /var/log...";
    sync();

    // ── Turn 2: agent final response ─────────────────────────
    const agentMsg3 = turn2.addAgentMessage();
    agentMsg3.appendDelta("I couldn't read /var/log due to permissions.");
    turn2.stopReason = "stop";
    turn2.model = "claude-sonnet-4-20250514";
    sync();

    // ── Turn 3: multiple tool calls ──────────────────────────
    const turn3 = session1.addTurn({ turnNumber: 3 });
    turn3.addUserMessage("Read data.json and config.yaml");
    const agentMsg4 = turn3.addAgentMessage();
    agentMsg4.appendDelta("I'll read both files for you.");

    const tc3 = turn3.addToolCall("call-003", "read_file", {
      path: "/tmp/data.json",
    });
    tc3.addResponse('{"name": "test", "value": 42}');

    const tc4 = turn3.addToolCall("call-004", "read_file", {
      path: "/tmp/config.yaml",
    });
    tc4.addResponse("port: 8080\nhost: localhost");

    turn3.stopReason = "stop";
    turn3.model = "claude-sonnet-4-20250514";
    turn3.usage = { input: 300, output: 120 };
    sync();

    // ════════════════════════════════════════════════════════════
    // VERIFY
    // ════════════════════════════════════════════════════════════

    // 1. JSON snapshots are identical
    expect(treeToJson(session2)).toEqual(treeToJson(session1));

    // 2. Same turns
    expect(session2).toBeInstanceOf(SessionState);
    expect(session2.turns).toHaveLength(3);

    // 3. Turn 1
    const t1 = session2.turns[0] as Turn;
    expect(t1).toBeInstanceOf(Turn);
    expect(t1.turnNumber).toBe(1);
    expect(t1.stopReason).toBe("tool-use");
    expect(t1.usage?.input).toBe(150);
    expect(t1.usage?.cacheRead).toBe(20);

    expect(t1.messages).toHaveLength(2);
    expect(t1.messages[0]).toBeInstanceOf(Message);
    expect(t1.messages[0]?.text).toBe("What files are in /tmp?");
    expect(t1.messages[1]?.text).toBe("Let me check that for you.");

    const thinkingBlocks1 = t1.messages[1]?.thinkingBlocks ?? [];
    expect(thinkingBlocks1).toHaveLength(1);
    expect(thinkingBlocks1[0]?.text).toBe("I should list the directory contents.");

    expect(t1.toolCalls).toHaveLength(1);
    const s_tc1 = t1.toolCalls[0] as ToolCall;
    expect(s_tc1).toBeInstanceOf(ToolCall);
    expect(s_tc1.callId).toBe("call-001");
    expect(s_tc1.args).toEqual({ path: "/tmp" });
    expect(s_tc1.result).toBe("data.json\nconfig.yaml\nREADME.md");

    // 4. Turn 2 (interleaved)
    const t2 = session2.turns[1] as Turn;
    expect(t2.messages).toHaveLength(3);
    expect(t2.messages[0]?.text).toBe("There are 3 files: data.json, config.yaml, README.md.");
    expect(t2.messages[1]?.text).toBe("Also check /var/log");
    expect(t2.messages[2]?.text).toBe("I couldn't read /var/log due to permissions.");

    const s_tc2 = t2.toolCalls[0] as ToolCall;
    expect(s_tc2.result).toBe("Permission denied");
    expect(s_tc2.isError).toBe(true);
    expect(s_tc2.progressText).toBe("Checking /var/log...");

    // 5. Turn 3 (multiple tool calls)
    const t3 = session2.turns[2] as Turn;
    expect(t3.toolCalls).toHaveLength(2);
    expect(t3.toolCalls[0]?.result).toBe('{"name": "test", "value": 42}');
    expect(t3.toolCalls[1]?.result).toBe("port: 8080\nhost: localhost");

    // 6. IDs match
    const ids1: string[] = [];
    const ids2: string[] = [];
    session1.visit((e) => {
      ids1.push(e.id);
      return undefined;
    });
    session2.visit((e) => {
      ids2.push(e.id);
      return undefined;
    });
    expect(ids2).toEqual(ids1);

    // 7. Flat streams identical
    expect([...toFlatStream(session2)]).toEqual([...toFlatStream(session1)]);
  });
});
