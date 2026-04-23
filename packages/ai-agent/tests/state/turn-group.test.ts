import { markdownToTree, treeToMarkdown } from "@statewalker/ai-agent-state";
import { describe, expect, it } from "vitest";
import {
  createAgentNodeFactory,
  NodeType,
  type Session,
  type SummarySection,
  type TurnGroup,
} from "../../src/state/index.js";

function makeSession(): Session {
  const factory = createAgentNodeFactory();
  return factory({ type: NodeType.session }) as Session;
}

describe("TurnGroup accessors", () => {
  it("summaryText round-trips through node.content", () => {
    const session = makeSession();
    const group = session.addChild({
      type: NodeType.turnGroup,
    }) as TurnGroup;

    group.summaryText = "decisions and results";
    expect(group.content).toBe("decisions and results");
    expect(group.summaryText).toBe("decisions and results");
  });

  it("sections round-trips through props.sections", () => {
    const session = makeSession();
    const group = session.addChild({
      type: NodeType.turnGroup,
    }) as TurnGroup;

    const sections: SummarySection[] = [
      { title: "Decisions", body: "chose X over Y", refs: ["t1", "t2"] },
    ];
    group.sections = sections;
    expect(group.props.sections).toEqual(sections);
    expect(group.sections).toEqual(sections);
  });

  it("clearing sections removes the props key", () => {
    const session = makeSession();
    const group = session.addChild({ type: NodeType.turnGroup }) as TurnGroup;
    group.sections = [{ title: "X", body: "y", refs: ["a"] }];
    expect(group.props.sections).toBeDefined();
    group.sections = undefined;
    expect(group.props.sections).toBeUndefined();
    expect("sections" in group.props).toBe(false);
  });

  it("depth defaults to 1 when absent", () => {
    const session = makeSession();
    const group = session.addChild({ type: NodeType.turnGroup }) as TurnGroup;
    expect(group.depth).toBe(1);
  });

  it("stamp, tokensEstimate, model round-trip", () => {
    const session = makeSession();
    const group = session.addChild({ type: NodeType.turnGroup }) as TurnGroup;
    group.stamp = "01JABCD";
    group.tokensEstimate = 1234;
    group.model = "claude-haiku-4-5";
    expect(group.props.stamp).toBe("01JABCD");
    expect(group.props.tokensEstimate).toBe(1234);
    expect(group.props.model).toBe("claude-haiku-4-5");
  });
});

describe("TurnGroup derived accessors", () => {
  it("coveredRange reports first and last raw turn ids", () => {
    const session = makeSession();
    session.addTurn(); // tail, kept verbatim
    const group = session.addChild({ type: NodeType.turnGroup }) as TurnGroup;
    const a = group.addChild({ type: NodeType.turn });
    group.addChild({ type: NodeType.turn });
    const c = group.addChild({ type: NodeType.turn });
    expect(group.coveredRange).toEqual({
      firstTurnId: a.id,
      lastTurnId: c.id,
    });
  });

  it("childTurnCount recurses through nested groups", () => {
    const session = makeSession();
    const outer = session.addChild({
      type: NodeType.turnGroup,
    }) as TurnGroup;
    outer.addChild({ type: NodeType.turn });
    const inner = outer.addChild({
      type: NodeType.turnGroup,
    }) as TurnGroup;
    inner.addChild({ type: NodeType.turn });
    inner.addChild({ type: NodeType.turn });
    inner.addChild({ type: NodeType.turn });
    expect(outer.childTurnCount).toBe(4);
    expect(inner.childTurnCount).toBe(3);
  });

  it("coveredRange returns undefined for an empty group", () => {
    const session = makeSession();
    const group = session.addChild({ type: NodeType.turnGroup }) as TurnGroup;
    expect(group.coveredRange).toBeUndefined();
    expect(group.childTurnCount).toBe(0);
  });
});

describe("Session.allTurns", () => {
  it("descends into nested groups and preserves document order", () => {
    const session = makeSession();
    const t0 = session.addTurn();
    const outer = session.addChild({
      type: NodeType.turnGroup,
    }) as TurnGroup;
    const t1 = outer.addChild({ type: NodeType.turn });
    const inner = outer.addChild({
      type: NodeType.turnGroup,
    }) as TurnGroup;
    const t2 = inner.addChild({ type: NodeType.turn });
    const t3 = inner.addChild({ type: NodeType.turn });
    const t4 = session.addTurn();

    const ids = session.allTurns().map((t) => t.id);
    expect(ids).toEqual([t0.id, t1.id, t2.id, t3.id, t4.id]);
  });

  it("turns getter stays non-recursive", () => {
    const session = makeSession();
    const tailOnly = session.addTurn();
    const group = session.addChild({
      type: NodeType.turnGroup,
    }) as TurnGroup;
    group.addChild({ type: NodeType.turn });
    group.addChild({ type: NodeType.turn });
    expect(session.turns.map((t) => t.id)).toEqual([tailOnly.id]);
  });
});

describe("TurnGroup markdown readability", () => {
  it("summary prose appears as section body, not as frontmatter", () => {
    const session = makeSession();
    const group = session.addChild({ type: NodeType.turnGroup }) as TurnGroup;
    group.summaryText = "The agent decided to refactor the auth module.";
    group.depth = 1;

    const md = treeToMarkdown(session);
    expect(md).toContain("The agent decided to refactor the auth module.");

    const groupSection = extractSection(md, group.id);
    expect(groupSection.frontmatter).toContain("type: turn_group");
    expect(groupSection.frontmatter).not.toContain("The agent decided to refactor");
    expect(groupSection.body).toContain("The agent decided to refactor the auth module.");
  });

  it("sections JSON round-trips through markdown frontmatter", () => {
    const session = makeSession();
    const group = session.addChild({ type: NodeType.turnGroup }) as TurnGroup;
    group.summaryText = "summary body";
    const sections: SummarySection[] = [
      { title: "Decisions", body: "X", refs: ["t1"] },
      { title: "Files", body: "auth.ts", refs: ["t2"] },
    ];
    group.sections = sections;

    const factory = createAgentNodeFactory();
    const md = treeToMarkdown(session);
    const restored = markdownToTree(md, factory) as Session;

    const restoredGroup = restored.children.find((c) => c.id === group.id) as TurnGroup;
    expect(restoredGroup).toBeDefined();
    expect(restoredGroup.summaryText).toBe("summary body");
    expect(restoredGroup.sections).toEqual(sections);
  });
});

function extractSection(md: string, nodeId: string): { frontmatter: string; body: string } {
  const segments = md.split(/^-{3,}\s*$/m);
  for (const seg of segments) {
    if (!seg.includes(`id: ${nodeId}`)) continue;
    const trimmed = seg.replace(/^\s*\n/, "");
    const emptyLineIdx = trimmed.search(/\n\s*\n/);
    if (emptyLineIdx === -1) {
      return { frontmatter: trimmed, body: "" };
    }
    const afterEmpty = trimmed.indexOf("\n", emptyLineIdx + 1);
    return {
      frontmatter: trimmed.slice(0, emptyLineIdx),
      body: afterEmpty >= 0 ? trimmed.slice(afterEmpty + 1) : "",
    };
  }
  throw new Error(`section for node ${nodeId} not found in markdown`);
}
