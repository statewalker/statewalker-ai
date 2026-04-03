import { describe, expect, it } from "vitest";
import { markdownToTree, treeToMarkdown } from "../src/markdown.js";
import { NodeType } from "../src/node-types.js";
import {
  createAgentNodeFactory,
  type Session,
  type Turn,
} from "../src/wrappers/index.js";

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
});

describe("markdown round-trip", () => {
  it("preserves full conversation structure", () => {
    const { session } = buildConversation();
    const md = treeToMarkdown(session);
    const restored = markdownToTree(md, factory) as Session;

    expect(restored.turns).toHaveLength(2);

    const t1 = restored.turns[0] as Turn;
    expect(t1.turnNumber).toBe(1);
    expect(t1.stopReason).toBe("tool-use");
    expect(t1.model).toBe("claude-sonnet-4-20250514");
    expect(t1.messages[0]?.text).toBe("Read /tmp/data.json");
    expect(t1.messages[1]?.text).toBe("Sure, let me read that file.");
    expect(t1.toolCalls[0]?.toolName).toBe("read_file");
    expect(t1.toolCalls[0]?.result).toBe('{"name": "test"}');

    const t2 = restored.turns[1] as Turn;
    expect(t2.stopReason).toBe("stop");
    expect(t2.messages[0]?.text).toBe("The file contains a JSON object.");
  });

  it("preserves IDs and parent refs", () => {
    const { session } = buildConversation();
    const md = treeToMarkdown(session);
    const restored = markdownToTree(md, factory);
    expect(restored.id).toBe(session.id);
    expect(restored.children[0]?.parent).toBe(restored);
  });
});
