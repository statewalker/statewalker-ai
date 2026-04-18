import { describe, expect, it } from "vitest";
import { newNodeFactory } from "../src/node-factory.js";
import { markdownToTree } from "../src/serialization/markdown-to-tree.js";
import { treeToJson } from "../src/serialization/tree-to-json.js";
import { treeToMarkdown } from "../src/serialization/tree-to-markdown.js";

const factory = newNodeFactory({});

describe("grouped tree serialisation round-trip", () => {
  it("markdown round-trip preserves wrapper id, type, content, props and child order", () => {
    const root = factory({ id: "root", type: "session", props: {} });
    root.addChild({ id: "a", type: "turn", props: {} });
    root.addChild({ id: "b", type: "turn", props: {} });
    root.addChild({ id: "c", type: "turn", props: {} });
    root.addChild({ id: "d", type: "turn", props: {} });

    const wrapper = root.groupChildren(1, 3, () => ({
      id: "wrap1",
      type: "turn_group",
      props: { depth: 1, stamp: "01J" },
      content: "summary of b and c",
    }));
    expect(wrapper.id).toBe("wrap1");

    const md = treeToMarkdown(root);
    const reconstructed = markdownToTree(md, factory);

    const expected = treeToJson(root);
    const actual = treeToJson(reconstructed);
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
  });

  it("nested groupings round-trip through markdown", () => {
    const root = factory({ id: "root", type: "session", props: {} });
    for (let i = 0; i < 6; i++) {
      root.addChild({ id: `t${i}`, type: "turn", props: {} });
    }
    // Wrap [t0,t1,t2] under g1, and [t3,t4] under g2 (positions shift after first splice).
    root.groupChildren(0, 3, () => ({
      id: "g1",
      type: "turn_group",
      props: { depth: 1 },
      content: "g1 summary",
    }));
    root.groupChildren(1, 3, () => ({
      id: "g2",
      type: "turn_group",
      props: { depth: 1 },
      content: "g2 summary",
    }));
    // Promote g1 + g2 under a depth-2 wrapper.
    root.groupChildren(0, 2, () => ({
      id: "g12",
      type: "turn_group",
      props: { depth: 2 },
      content: "g1+g2 summary",
    }));

    const md = treeToMarkdown(root);
    const reconstructed = markdownToTree(md, factory);

    const expected = JSON.stringify(treeToJson(root));
    const actual = JSON.stringify(treeToJson(reconstructed));
    expect(actual).toBe(expected);
  });
});
