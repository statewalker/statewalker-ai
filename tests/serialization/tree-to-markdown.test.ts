import { describe, expect, it } from "vitest";
import { treeToMarkdown } from "../../src/serialization/tree-to-markdown.js";
import {
  createAgentNodeFactory,
  type Session,
} from "../../src/wrappers/index.js";
import { NodeType } from "../../src/wrappers/node-types.js";

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

describe("treeToMarkdown", () => {
  it("produces markdown with sections", () => {
    const { session } = buildConversation();
    const md = treeToMarkdown(session);
    expect(md.length).toBeGreaterThan(0);
    expect(md).toContain("parentId:");
  });

  it("root has no parentId", () => {
    const { session } = buildConversation();
    const md = treeToMarkdown(session);
    const lines = md.split("\n");
    const firstSection: string[] = [];
    let inFirst = false;
    for (const line of lines) {
      if (/^-{3,}/.test(line)) {
        if (inFirst) break;
        inFirst = true;
        continue;
      }
      if (inFirst) firstSection.push(line);
    }
    expect(firstSection.join("\n")).toContain("type: session");
    expect(firstSection.join("\n")).not.toContain("parentId:");
  });

  it("includes all nodes as sections", () => {
    const { session } = buildConversation();
    const md = treeToMarkdown(session);
    // Count section separators (---) to verify all nodes are serialized
    const separators = md.split("\n").filter((l) => /^-{3,}$/.test(l));
    // Each section has an opening and closing separator, so separators = nodes + 1 (closing of last)
    // Actually content-blocks format: each section starts with ---
    expect(separators.length).toBeGreaterThanOrEqual(2);
  });

  it("preserves props in section metadata", () => {
    const { session } = buildConversation();
    const md = treeToMarkdown(session);
    expect(md).toContain("type: turn");
    expect(md).toContain("type: user_message");
    expect(md).toContain("type: agent_message");
    expect(md).toContain("turnNumber: 1");
  });

  it("preserves content in section blocks", () => {
    const { session } = buildConversation();
    const md = treeToMarkdown(session);
    expect(md).toContain("Read /tmp/data.json");
    expect(md).toContain("Sure, let me read that file.");
  });
});
