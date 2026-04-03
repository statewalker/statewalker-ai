import { SnowflakeId } from "@repo/ids";
import { describe, expect, it } from "vitest";
import { applyFlat } from "../src/apply-flat.js";
import { createEntry } from "../src/create-entry.js";
import { toFlatStream } from "../src/flat-stream.js";
import { treeToJson } from "../src/json.js";
import { NodeType } from "../src/node-types.js";
import {
  createAgentNodeFactory,
  Message,
  Session,
  ToolCall,
  Turn,
} from "../src/wrappers.js";

const factory = createAgentNodeFactory();

describe("Live sync: session1 → session2 via FlatTreeEntry stream", () => {
  it("replicates a complex interleaved conversation", () => {
    let time = 1700000000000;
    const idGen = new SnowflakeId({ now: () => time++ });

    // ── Create session1 (empty) ──────────────────────────────
    const session1 = new Session(
      createEntry({ type: NodeType.session, idGen }),
      factory,
    );

    // ── Create session2 as a copy of session1 ────────────────
    const session2 = applyFlat(
      undefined,
      toFlatStream(session1),
      factory,
    ) as Session;

    // ── Subscribe session2 to session1 updates ───────────────
    // Track the last synced point
    let lastSyncId = session2.id;

    function sync() {
      const delta = toFlatStream(session1, lastSyncId);
      applyFlat(session2, delta, factory);
      // Advance sync cursor to latest id in session1
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

    // ── User steering mid-stream (adds message to turn 2) ────
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

    // ── Turn 3: user asks follow-up, agent responds with multiple tool calls ──
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
    // VERIFY: session2 matches session1 exactly
    // ════════════════════════════════════════════════════════════

    // 1. JSON snapshots are identical
    const json1 = treeToJson(session1);
    const json2 = treeToJson(session2);
    expect(json2).toEqual(json1);

    // 2. Same number of turns
    expect(session2).toBeInstanceOf(Session);
    expect(session2.turns).toHaveLength(3);

    // 3. Turn 1 structure
    const t1 = session2.turns[0] as Turn;
    expect(t1).toBeInstanceOf(Turn);
    expect(t1.turnNumber).toBe(1);
    expect(t1.stopReason).toBe("tool-use");
    expect(t1.model).toBe("claude-sonnet-4-20250514");
    expect(t1.usage?.input).toBe(150);
    expect(t1.usage?.cacheRead).toBe(20);

    expect(t1.messages).toHaveLength(2);
    expect(t1.messages[0]).toBeInstanceOf(Message);
    expect(t1.messages[0]?.role).toBe("user");
    expect(t1.messages[0]?.text).toBe("What files are in /tmp?");
    expect(t1.messages[1]?.role).toBe("assistant");
    expect(t1.messages[1]?.text).toBe("Let me check that for you.");

    // Thinking block
    const thinkingBlocks1 = t1.messages[1]?.thinkingBlocks ?? [];
    expect(thinkingBlocks1).toHaveLength(1);
    expect(thinkingBlocks1[0]).toBeInstanceOf(Message);
    expect(thinkingBlocks1[0]?.text).toBe(
      "I should list the directory contents.",
    );

    // Tool call
    expect(t1.toolCalls).toHaveLength(1);
    const synced_tc1 = t1.toolCalls[0] as ToolCall;
    expect(synced_tc1).toBeInstanceOf(ToolCall);
    expect(synced_tc1.callId).toBe("call-001");
    expect(synced_tc1.toolName).toBe("list_files");
    expect(synced_tc1.args).toEqual({ path: "/tmp" });
    expect(synced_tc1.result).toBe("data.json\nconfig.yaml\nREADME.md");
    expect(synced_tc1.isError).toBe(false);

    // 4. Turn 2 structure (interleaved user + agent + tool)
    const t2 = session2.turns[1] as Turn;
    expect(t2).toBeInstanceOf(Turn);
    expect(t2.turnNumber).toBe(2);
    expect(t2.stopReason).toBe("stop");

    // Messages: agent, user steering, agent final
    expect(t2.messages).toHaveLength(3);
    expect(t2.messages[0]?.role).toBe("assistant");
    expect(t2.messages[0]?.text).toBe(
      "There are 3 files: data.json, config.yaml, README.md.",
    );
    expect(t2.messages[1]?.role).toBe("user");
    expect(t2.messages[1]?.text).toBe("Also check /var/log");
    expect(t2.messages[2]?.role).toBe("assistant");
    expect(t2.messages[2]?.text).toBe(
      "I couldn't read /var/log due to permissions.",
    );

    // Tool call with error
    expect(t2.toolCalls).toHaveLength(1);
    const synced_tc2 = t2.toolCalls[0] as ToolCall;
    expect(synced_tc2.callId).toBe("call-002");
    expect(synced_tc2.toolName).toBe("list_files");
    expect(synced_tc2.result).toBe("Permission denied");
    expect(synced_tc2.isError).toBe(true);
    expect(synced_tc2.progressText).toBe("Checking /var/log...");

    // 5. Turn 3 structure (multiple tool calls)
    const t3 = session2.turns[2] as Turn;
    expect(t3).toBeInstanceOf(Turn);
    expect(t3.turnNumber).toBe(3);
    expect(t3.stopReason).toBe("stop");
    expect(t3.usage?.input).toBe(300);

    expect(t3.messages).toHaveLength(2);
    expect(t3.messages[0]?.role).toBe("user");
    expect(t3.messages[0]?.text).toBe("Read data.json and config.yaml");
    expect(t3.messages[1]?.role).toBe("assistant");
    expect(t3.messages[1]?.text).toBe("I'll read both files for you.");

    expect(t3.toolCalls).toHaveLength(2);
    const synced_tc3 = t3.toolCalls[0] as ToolCall;
    expect(synced_tc3.callId).toBe("call-003");
    expect(synced_tc3.toolName).toBe("read_file");
    expect(synced_tc3.args).toEqual({ path: "/tmp/data.json" });
    expect(synced_tc3.result).toBe('{"name": "test", "value": 42}');

    const synced_tc4 = t3.toolCalls[1] as ToolCall;
    expect(synced_tc4.callId).toBe("call-004");
    expect(synced_tc4.toolName).toBe("read_file");
    expect(synced_tc4.args).toEqual({ path: "/tmp/config.yaml" });
    expect(synced_tc4.result).toBe("port: 8080\nhost: localhost");

    // 6. All Snowflake IDs match between sessions
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

    // 7. Flat streams are identical
    const flat1 = [...toFlatStream(session1)];
    const flat2 = [...toFlatStream(session2)];
    expect(flat2).toEqual(flat1);
  });
});
