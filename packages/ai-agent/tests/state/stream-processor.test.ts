import { describe, expect, it } from "vitest";
import { createAgentNodeFactory, type Session } from "../../src/state/index.js";
import { NodeType } from "../../src/state/node-types.js";
import type { Turn } from "../../src/state/turn.js";

function makeSession(): Session {
  const factory = createAgentNodeFactory();
  return factory({ type: "session" }) as Session;
}

function makeTurn(): Turn {
  return makeSession().addTurn();
}

describe("Turn stream handlers", () => {
  it("handleText: text-start creates agent message, text-delta appends", () => {
    const turn = makeTurn();

    expect(turn.handleText({ type: "text-start", id: "t1" })).toBeUndefined();

    const agentMsgs = turn.childrenOfType(NodeType.agentMessage);
    expect(agentMsgs).toHaveLength(1);

    const log1 = turn.handleText({
      type: "text-delta",
      id: "t1",
      text: "Hello ",
    });
    expect(log1).toEqual({
      type: "text-delta",
      turnId: turn.id,
      text: "Hello ",
    });

    const log2 = turn.handleText({
      type: "text-delta",
      id: "t1",
      text: "world",
    });
    expect(log2?.type).toBe("text-delta");

    expect(turn.handleText({ type: "text-end", id: "t1" })).toBeUndefined();

    expect(agentMsgs).toHaveLength(1);
    expect(agentMsgs[0]?.content).toBe("Hello world");
  });

  it("handleText: stores providerMetadata on agent message", () => {
    const turn = makeTurn();
    turn.handleText({
      type: "text-start",
      id: "t1",
      providerMetadata: { thought_signature: "abc" },
    });

    const msg = turn.childrenOfType(NodeType.agentMessage)[0];
    expect(msg?.props.providerMetadata).toEqual({
      thought_signature: "abc",
    });
  });

  it("handleReasoning: creates thinking block, appends deltas", () => {
    const turn = makeTurn();

    turn.handleReasoning({ type: "reasoning-start", id: "r1" });

    const agentMsgs = turn.childrenOfType(NodeType.agentMessage);
    expect(agentMsgs).toHaveLength(1);

    const log = turn.handleReasoning({
      type: "reasoning-delta",
      id: "r1",
      text: "Let me think",
    });
    expect(log).toEqual({
      type: "reasoning",
      turnId: turn.id,
      text: "Let me think",
    });

    turn.handleReasoning({ type: "reasoning-end", id: "r1" });

    const thinking = agentMsgs[0]?.children.filter(
      (c) => c.type === NodeType.thinking,
    );
    expect(thinking).toHaveLength(1);
    expect(thinking?.[0]?.content).toBe("Let me think");
  });

  it("handleTool: tool-call creates node, tool-result attaches by callId", () => {
    const turn = makeTurn();

    const callLog = turn.handleTool({
      type: "tool-call",
      toolCallId: "c1",
      toolName: "read",
      input: { path: "/tmp" },
    });
    expect(callLog).toMatchObject({
      type: "tool-call",
      toolCallId: "c1",
      toolName: "read",
    });

    const resultLog = turn.handleTool({
      type: "tool-result",
      toolCallId: "c1",
      toolName: "read",
      output: "file contents",
    });
    expect(resultLog).toMatchObject({
      type: "tool-result",
      toolCallId: "c1",
    });

    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0]?.toolName).toBe("read");
    expect(turn.toolCalls[0]?.result).toBe("file contents");
  });

  it("handleTool: tool-error adds error response by callId and yields a log", () => {
    const turn = makeTurn();
    turn.handleTool({
      type: "tool-call",
      toolCallId: "c2",
      toolName: "write",
      input: {},
    });

    const log = turn.handleTool({
      type: "tool-error",
      toolCallId: "c2",
      toolName: "write",
      error: new Error("permission denied"),
    });

    expect(turn.toolCalls[0]?.isError).toBe(true);
    expect(turn.toolCalls[0]?.result).toBe("permission denied");
    expect(log).toMatchObject({
      type: "tool-error",
      toolCallId: "c2",
      toolName: "write",
      message: "permission denied",
    });
  });

  it("handleToolInput: streams input deltas before tool-call", () => {
    const turn = makeTurn();

    const log = turn.handleToolInput({
      type: "tool-input-start",
      id: "ti1",
      toolName: "search",
    });
    expect(log?.type).toBe("tool-call");

    turn.handleToolInput({
      type: "tool-input-delta",
      id: "ti1",
      delta: '{"query":',
    });
    turn.handleToolInput({
      type: "tool-input-delta",
      id: "ti1",
      delta: '"hello"}',
    });

    turn.handleToolInput({ type: "tool-input-end", id: "ti1" });
    expect(turn.toolCalls.length).toBeGreaterThanOrEqual(1);
    expect(turn.toolCalls[0]?.request?.content).toBe('{"query":"hello"}');
  });

  it("handleToolInput: parallel tool calls with interleaved deltas", () => {
    const turn = makeTurn();

    // Start two tool calls
    turn.handleToolInput({
      type: "tool-input-start",
      id: "a",
      toolName: "read",
    });
    turn.handleToolInput({
      type: "tool-input-start",
      id: "b",
      toolName: "write",
    });

    // Interleave deltas
    turn.handleToolInput({
      type: "tool-input-delta",
      id: "b",
      delta: '{"path":',
    });
    turn.handleToolInput({
      type: "tool-input-delta",
      id: "a",
      delta: '{"file":',
    });
    turn.handleToolInput({ type: "tool-input-delta", id: "a", delta: '"x"}' });
    turn.handleToolInput({ type: "tool-input-delta", id: "b", delta: '"y"}' });

    turn.handleToolInput({ type: "tool-input-end", id: "a" });
    turn.handleToolInput({ type: "tool-input-end", id: "b" });

    expect(turn.toolCalls).toHaveLength(2);
    const tcA = turn.toolCalls.find((t) => t.callId === "a");
    const tcB = turn.toolCalls.find((t) => t.callId === "b");
    expect(tcA?.request?.content).toBe('{"file":"x"}');
    expect(tcB?.request?.content).toBe('{"path":"y"}');
  });

  it("handleToolInput + handleTool: tool-call reuses existing node from tool-input-start", () => {
    const turn = makeTurn();

    // Stream starts with tool-input-start
    turn.handleToolInput({
      type: "tool-input-start",
      id: "c1",
      toolName: "get_time",
      providerMetadata: { google: { sig: "abc" } },
    });

    // Input deltas arrive
    turn.handleToolInput({
      type: "tool-input-delta",
      id: "c1",
      delta: "{}",
    });
    turn.handleToolInput({ type: "tool-input-end", id: "c1" });

    // Then the complete tool-call event arrives with the same id
    turn.handleTool({
      type: "tool-call",
      toolCallId: "c1",
      toolName: "get_time",
      input: {},
    });

    // Must have exactly one tool call node, not two
    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0]?.callId).toBe("c1");
    expect(turn.toolCalls[0]?.args).toEqual({});
  });

  it("handleTool: duplicate tool-call events reuse existing node", () => {
    const turn = makeTurn();

    turn.handleTool({
      type: "tool-call",
      toolCallId: "c1",
      toolName: "read",
      input: { path: "/tmp" },
    });

    // Second tool-call event with same id (e.g. from a retry or update)
    turn.handleTool({
      type: "tool-call",
      toolCallId: "c1",
      toolName: "read",
      input: { path: "/tmp/updated" },
    });

    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0]?.args).toEqual({ path: "/tmp/updated" });
  });

  it("handleFinishStep: stops turn, clears active state", () => {
    const turn = makeTurn();
    turn.handleText({ type: "text-start", id: "t1" });
    turn.handleText({ type: "text-delta", id: "t1", text: "Hi" });

    const log = turn.handleFinishStep({
      type: "finish-step",
      finishReason: "stop",
    });

    expect(log).toEqual({
      type: "step-finish",
      turnId: turn.id,
      finishReason: "stop",
    });
    expect(turn.stopReason).toBe("stop");
  });

  it("handleFinishStep: accumulates per-step usage (SDK v6 property names)", () => {
    const turn = makeTurn();

    turn.handleFinishStep({
      type: "finish-step",
      finishReason: "tool-calls",
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    expect(turn.usage).toEqual({ input: 100, output: 50 });

    // Second step accumulates
    turn.handleFinishStep({
      type: "finish-step",
      finishReason: "stop",
      usage: { inputTokens: 80, outputTokens: 30 },
    });

    expect(turn.usage).toEqual({ input: 180, output: 80 });
  });

  it("handleFinishStep: captures cache and total token details", () => {
    const turn = makeTurn();

    turn.handleFinishStep({
      type: "finish-step",
      finishReason: "stop",
      usage: {
        inputTokens: 200,
        outputTokens: 60,
        totalTokens: 260,
        inputTokenDetails: { cacheReadTokens: 150, cacheWriteTokens: 50 },
      },
    });

    expect(turn.usage).toEqual({
      input: 200,
      output: 60,
      totalTokens: 260,
      cacheRead: 150,
      cacheWrite: 50,
    });
  });

  it("handleFinish: sets authoritative total usage (SDK v6 property names)", () => {
    const turn = makeTurn();

    // Accumulated from steps
    turn.handleFinishStep({
      type: "finish-step",
      finishReason: "stop",
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    // finish overwrites with authoritative total
    turn.handleFinish({
      type: "finish",
      finishReason: "stop",
      totalUsage: { inputTokens: 120, outputTokens: 60 },
    });

    expect(turn.usage).toEqual({ input: 120, output: 60 });
  });

  it("handleError: creates error node and returns log", () => {
    const turn = makeTurn();
    const log = turn.handleError({
      type: "error",
      error: new Error("API failed"),
    });

    expect(log).toEqual({
      type: "error",
      turnId: turn.id,
      message: "API failed",
    });

    const errorNodes = turn.children.filter((c) => c.type === NodeType.error);
    expect(errorNodes).toHaveLength(1);
    expect(errorNodes[0]?.content).toBe("API failed");
  });

  it("handleMetadata: adds source/file as child nodes", () => {
    const turn = makeTurn();
    turn.handleMetadata({ type: "source", url: "https://example.com" });
    turn.handleMetadata({ type: "file", path: "/tmp/test.txt" });

    expect(turn.children.filter((c) => c.type === "source")).toHaveLength(1);
    expect(turn.children.filter((c) => c.type === "file")).toHaveLength(1);
  });

  it("full sequence: reasoning + text + tool in one step", () => {
    const turn = makeTurn();

    // Reasoning
    turn.handleReasoning({ type: "reasoning-start", id: "r1" });
    turn.handleReasoning({
      type: "reasoning-delta",
      id: "r1",
      text: "Thinking...",
    });
    turn.handleReasoning({ type: "reasoning-end", id: "r1" });

    // Text
    turn.handleText({ type: "text-start", id: "t1" });
    turn.handleText({ type: "text-delta", id: "t1", text: "Let me check" });
    turn.handleText({ type: "text-end", id: "t1" });

    // Tool
    turn.handleTool({
      type: "tool-call",
      toolCallId: "c1",
      toolName: "read",
      input: {},
    });
    turn.handleTool({
      type: "tool-result",
      toolCallId: "c1",
      toolName: "read",
      output: "ok",
    });

    // Finish
    turn.handleFinishStep({ type: "finish-step", finishReason: "tool-calls" });

    expect(turn.stopReason).toBe("tool-calls");
    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0]?.result).toBe("ok");

    const agentMsgs = turn.children.filter(
      (c) => c.type === NodeType.agentMessage,
    );
    expect(agentMsgs).toHaveLength(1);
    expect(agentMsgs[0]?.content).toBe("Let me check");

    // Reasoning and text share the same agent message
    const thinking = agentMsgs[0]?.children.filter(
      (c) => c.type === NodeType.thinking,
    );
    expect(thinking).toHaveLength(1);
    expect(thinking?.[0]?.content).toBe("Thinking...");
  });

  it("multi-step: step-finish creates new agent message for next step", () => {
    const turn = makeTurn();

    // Step 1: text
    turn.handleText({ type: "text-start", id: "t1" });
    turn.handleText({ type: "text-delta", id: "t1", text: "Step one" });
    turn.handleText({ type: "text-end", id: "t1" });
    turn.handleFinishStep({ type: "finish-step", finishReason: "tool-calls" });

    // Step 2: text (should create new agent message)
    turn.handleText({ type: "text-start", id: "t2" });
    turn.handleText({ type: "text-delta", id: "t2", text: "Step two" });
    turn.handleText({ type: "text-end", id: "t2" });
    turn.handleFinishStep({ type: "finish-step", finishReason: "stop" });

    const agentMsgs = turn.children.filter(
      (c) => c.type === NodeType.agentMessage,
    );
    expect(agentMsgs).toHaveLength(2);
    expect(agentMsgs[0]?.content).toBe("Step one");
    expect(agentMsgs[1]?.content).toBe("Step two");
  });
});
