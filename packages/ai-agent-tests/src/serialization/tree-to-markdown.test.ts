import {
  createAgentNodeFactory,
  NodeType,
  type Session,
  sessionToMarkdown,
} from "@statewalker/ai-agent";
import { describe, expect, it } from "vitest";

const factory = createAgentNodeFactory();

function buildConversation() {
  const session = factory({ type: NodeType.session }) as Session;
  const turn1 = session.addTurn({ turnNumber: 1 });
  turn1.addUserMessage("Read /tmp/data.json");
  const agentMsg = turn1.addAgentMessage();
  agentMsg.appendDelta("Sure, let me read that file.");
  const tc = turn1.addToolCall("call-001", "read_file", {
    path: "/tmp/data.json",
  });
  tc.addResponse('{"name": "test"}');
  turn1.stopReason = "tool-use";
  turn1.model = "claude-sonnet-4-20250514";

  const turn2 = session.addTurn({ turnNumber: 2 });
  const agentMsg2 = turn2.addAgentMessage();
  agentMsg2.appendDelta("The file contains a JSON object.");
  turn2.stopReason = "stop";

  return { session };
}

describe("sessionToMarkdown", () => {
  it("produces non-empty markdown with delimiters", async () => {
    const { session } = buildConversation();
    const md = await sessionToMarkdown(session);
    expect(md.length).toBeGreaterThan(0);
    const delimiters = md.split("\n").filter((l) => /^---+$/.test(l));
    // One delimiter per node (session + 2 turns + messages + toolcall + tool-* nodes)
    expect(delimiters.length).toBeGreaterThanOrEqual(2);
  });

  it("encodes parentId in props for non-root nodes", async () => {
    const { session } = buildConversation();
    const md = await sessionToMarkdown(session);
    expect(md).toContain("parentId=");
  });

  it("includes node type in props", async () => {
    const { session } = buildConversation();
    const md = await sessionToMarkdown(session);
    expect(md).toContain("type=session");
    expect(md).toContain("type=turn");
    expect(md).toContain("type=user_message");
    expect(md).toContain("type=agent_message");
  });

  it("preserves textual content", async () => {
    const { session } = buildConversation();
    const md = await sessionToMarkdown(session);
    expect(md).toContain("Read /tmp/data.json");
    expect(md).toContain("Sure, let me read that file.");
  });
});
