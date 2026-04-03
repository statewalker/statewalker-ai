import { SnowflakeId } from "@repo/ids";
import { describe, expect, it } from "vitest";
import { markdownToTree, treeToMarkdown } from "../src/markdown.js";
import { TreeEntry } from "../src/tree-entry.js";
import type { TurnView } from "../src/wrappers.js";
import { NodeType, SessionView } from "../src/wrappers.js";

function buildConversation() {
  let time = 1700000000000;
  const idGen = new SnowflakeId({ now: () => time++ });

  const root = new TreeEntry({ type: NodeType.session, idGen });
  const session = new SessionView(root);

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

  return { root, session };
}

describe("treeToMarkdown", () => {
  it("produces non-empty markdown", () => {
    const { root } = buildConversation();
    const md = treeToMarkdown(root);
    expect(md.length).toBeGreaterThan(0);
  });

  it("contains section separators", () => {
    const { root } = buildConversation();
    const md = treeToMarkdown(root);
    const separators = md.split("\n").filter((line) => /^-{3,}\s*$/.test(line));
    // At least the frontmatter separator + section separators
    expect(separators.length).toBeGreaterThanOrEqual(2);
  });

  it("root section has no parentId", () => {
    const { root } = buildConversation();
    const md = treeToMarkdown(root);
    const lines = md.split("\n");
    // First section (after ---) should have id and type but not parentId
    const firstSectionLines: string[] = [];
    let inFirst = false;
    for (const line of lines) {
      if (/^-{3,}/.test(line)) {
        if (inFirst) break;
        inFirst = true;
        continue;
      }
      if (inFirst) firstSectionLines.push(line);
    }
    const propsText = firstSectionLines.join("\n");
    expect(propsText).toContain("type: session");
    expect(propsText).not.toContain("parentId:");
  });

  it("child sections have parentId", () => {
    const { root } = buildConversation();
    const md = treeToMarkdown(root);
    expect(md).toContain("parentId:");
  });
});

describe("markdownToTree", () => {
  it("reconstructs tree from markdown", () => {
    const { root } = buildConversation();
    const md = treeToMarkdown(root);
    const restored = markdownToTree(md);

    const session = new SessionView(restored);
    expect(session.turns).toHaveLength(2);
  });
});

describe("markdown round-trip", () => {
  it("preserves full conversation structure", () => {
    const { root } = buildConversation();
    const md = treeToMarkdown(root);
    const restored = markdownToTree(md);

    const session = new SessionView(restored);
    expect(session.turns).toHaveLength(2);

    const t1 = session.turns[0] as TurnView;
    expect(t1.turnNumber).toBe(1);
    expect(t1.stopReason).toBe("tool-use");
    expect(t1.model).toBe("claude-sonnet-4-20250514");

    const msgs = t1.messages;
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.role).toBe("user");
    expect(msgs[0]?.text).toBe("Read /tmp/data.json");
    expect(msgs[1]?.role).toBe("assistant");
    expect(msgs[1]?.text).toBe("Sure, let me read that file.");

    const tcs = t1.toolCalls;
    expect(tcs).toHaveLength(1);
    expect(tcs[0]?.toolName).toBe("read_file");
    expect(tcs[0]?.callId).toBe("call-001");
    expect(tcs[0]?.args).toEqual({ path: "/tmp/data.json" });
    expect(tcs[0]?.result).toBe('{"name": "test"}');

    const t2 = session.turns[1] as TurnView;
    expect(t2.turnNumber).toBe(2);
    expect(t2.stopReason).toBe("stop");
    expect(t2.messages[0]?.text).toBe("The file contains a JSON object.");
  });

  it("preserves Snowflake IDs", () => {
    const { root } = buildConversation();
    const originalId = root.id;
    const md = treeToMarkdown(root);
    const restored = markdownToTree(md);
    expect(restored.id).toBe(originalId);
  });

  it("preserves parent-child relationships", () => {
    const { root } = buildConversation();
    const md = treeToMarkdown(root);
    const restored = markdownToTree(md);

    expect(restored.parent).toBeUndefined();
    const turn = restored.children?.[0];
    expect(turn?.parent).toBe(restored);
    expect(turn?.parentId).toBe(restored.id);
  });

  it("handles content with special characters", () => {
    const root = new TreeEntry({ type: NodeType.session });
    const session = new SessionView(root);
    const turn = session.addTurn({ turnNumber: 1 });
    turn.addUserMessage("Code:\n```js\nconsole.log('hello');\n```");

    const md = treeToMarkdown(root);
    const restored = markdownToTree(md);
    const restoredSession = new SessionView(restored);
    const msg = restoredSession.turns[0]?.messages[0];
    expect(msg?.text).toContain("console.log('hello');");
  });
});
