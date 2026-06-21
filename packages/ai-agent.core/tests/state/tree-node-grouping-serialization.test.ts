import { describe, expect, it } from "vitest";
import { applyFlat } from "../../src/state/serialization/apply-flat.js";
import { deserialize } from "../../src/state/serialization/deserialize.js";
import { serialize } from "../../src/state/serialization/serialize.js";
import { toFlatStream } from "../../src/state/serialization/to-flat-stream.js";
import { treeToJson } from "../../src/state/serialization/tree-to-json.js";
import type { TreeNode } from "../../src/state/tree-node.js";
import { newNodeFactory } from "../../src/state/tree-node-factory.js";
import type { FlatTreeEntry, NodeFactory } from "../../src/state/tree-types.js";

const factory: NodeFactory = newNodeFactory({});

async function roundTrip(root: TreeNode): Promise<TreeNode> {
  const flat = Array.from(toFlatStream(root));
  const nodes = flat.map((f) => ({
    props: flatToProps(f),
    content: f.content ?? "",
  }));
  const chunks: string[] = [];
  for await (const chunk of serialize(nodes)) chunks.push(chunk);
  const md = chunks.join("");
  const back: FlatTreeEntry[] = [];
  for await (const node of deserialize([md])) {
    back.push(propsToFlat(node.props, node.content));
  }
  return applyFlat(undefined, back, factory);
}

function flatToProps(f: FlatTreeEntry): Record<string, string> {
  const props: Record<string, string> = { id: f.id };
  if (f.parentId) props.parentId = f.parentId;
  for (const [k, v] of Object.entries(f.props)) {
    if (v === undefined) continue;
    props[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return props;
}

function propsToFlat(p: Record<string, string>, content: string): FlatTreeEntry {
  const { id, parentId, ...rest } = p;
  if (!id) throw new Error("missing id");
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) props[k] = parseScalar(v);
  const flat: FlatTreeEntry = { id, props };
  if (parentId) flat.parentId = parentId;
  if (content !== "") flat.content = content;
  return flat;
}

function parseScalar(v: string): unknown {
  if (v.startsWith("{") || v.startsWith("[") || v === "true" || v === "false" || v === "null") {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  const n = Number(v);
  if (!Number.isNaN(n) && v.trim() !== "") return n;
  return v;
}

describe("grouped tree serialisation round-trip", () => {
  it("markdown round-trip preserves wrapper id, type, content, props and child order", async () => {
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

    const reconstructed = await roundTrip(root);
    const expected = treeToJson(root);
    const actual = treeToJson(reconstructed);
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
  });

  it("nested groupings round-trip through markdown", async () => {
    const root = factory({ id: "root", type: "session", props: {} });
    for (let i = 0; i < 6; i++) {
      root.addChild({ id: `t${i}`, type: "turn", props: {} });
    }
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
    root.groupChildren(0, 2, () => ({
      id: "g12",
      type: "turn_group",
      props: { depth: 2 },
      content: "g1+g2 summary",
    }));

    const reconstructed = await roundTrip(root);
    const expected = JSON.stringify(treeToJson(root));
    const actual = JSON.stringify(treeToJson(reconstructed));
    expect(actual).toBe(expected);
  });
});
