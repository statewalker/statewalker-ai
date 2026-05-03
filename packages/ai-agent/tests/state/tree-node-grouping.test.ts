import { describe, expect, it, vi } from "vitest";
import { treeToJson } from "../../src/state/serialization/tree-to-json.js";
import type { TreeNode } from "../../src/state/tree-node.js";
import { newNodeFactory } from "../../src/state/tree-node-factory.js";

const factory = newNodeFactory({});

function create(type: string) {
  return factory({ type });
}

describe("TreeNode.groupChildren", () => {
  it("wraps a mid-range under a new wrapper at the slice position", () => {
    const parent = create("session");
    const a = parent.addChild({ id: "a", type: "turn" });
    const b = parent.addChild({ id: "b", type: "turn" });
    const c = parent.addChild({ id: "c", type: "turn" });
    const d = parent.addChild({ id: "d", type: "turn" });
    const e = parent.addChild({ id: "e", type: "turn" });

    const wrapper = parent.groupChildren(1, 4, () => ({
      type: "turn_group",
    }));

    const childIds = parent.children.map((c) => c.id);
    expect(childIds).toEqual([a.id, wrapper.id, e.id]);

    const wrappedIds = wrapper.children.map((c) => c.id);
    expect(wrappedIds).toEqual([b.id, c.id, d.id]);
  });

  it("rejects empty range", () => {
    const parent = create("session");
    parent.addChild({ type: "turn" });
    parent.addChild({ type: "turn" });
    expect(() => parent.groupChildren(1, 1, () => ({ type: "turn_group" }))).toThrow(
      /empty or reversed/,
    );
    expect(parent.children).toHaveLength(2);
  });

  it("rejects reversed range", () => {
    const parent = create("session");
    parent.addChild({ type: "turn" });
    parent.addChild({ type: "turn" });
    parent.addChild({ type: "turn" });
    expect(() => parent.groupChildren(2, 1, () => ({ type: "turn_group" }))).toThrow(
      /empty or reversed/,
    );
    expect(parent.children).toHaveLength(3);
  });

  it("rejects out-of-bounds range", () => {
    const parent = create("session");
    parent.addChild({ type: "turn" });
    expect(() => parent.groupChildren(0, 5, () => ({ type: "turn_group" }))).toThrow(
      /out of bounds/,
    );
  });

  it("preserves child identity and updates parent pointer", () => {
    const parent = create("session");
    parent.addChild({ id: "a", type: "turn" });
    const b = parent.addChild({ id: "b", type: "turn" });
    const c = parent.addChild({ id: "c", type: "turn" });
    parent.addChild({ id: "d", type: "turn" });

    const wrapper = parent.groupChildren(1, 3, () => ({ type: "turn_group" }));

    expect(b.parent).toBe(wrapper);
    expect(c.parent).toBe(wrapper);
    expect(wrapper.parent).toBe(parent);
    // Same reference after regrouping — cache identity preserved.
    expect(wrapper.children[0]).toBe(b);
    expect(wrapper.children[1]).toBe(c);
  });

  it("emits exactly one notification on the parent", () => {
    const parent = create("session");
    parent.addChild({ type: "turn" });
    parent.addChild({ type: "turn" });
    parent.addChild({ type: "turn" });
    // Touch caches.
    void parent.children;

    const listener = vi.fn();
    parent.onUpdate(listener);

    parent.groupChildren(0, 2, () => ({ type: "turn_group" }));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("routes child events through the wrapper after grouping", () => {
    const parent = create("session");
    const a = parent.addChild({ id: "a", type: "turn" });
    const b = parent.addChild({ id: "b", type: "turn" });
    const wrapper = parent.groupChildren(0, 2, () => ({ type: "turn_group" }));

    const wrapperListener = vi.fn();
    const parentListener = vi.fn();
    wrapper.onUpdate(wrapperListener);
    parent.onUpdate(parentListener);

    a.touch();
    expect(wrapperListener).toHaveBeenCalled();
    expect(parentListener).toHaveBeenCalled();
    // Second child routes the same way.
    b.touch();
    expect(wrapperListener.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("factory can customise wrapper props and content", () => {
    const parent = create("session");
    parent.addChild({ id: "a", type: "turn" });
    parent.addChild({ id: "b", type: "turn" });
    const wrapper = parent.groupChildren(0, 2, (adopted) => ({
      type: "turn_group",
      props: { depth: 1, adoptedCount: adopted.length },
      content: "summary text",
    }));
    expect(wrapper.content).toBe("summary text");
    expect(wrapper.props.depth).toBe(1);
    expect(wrapper.props.adoptedCount).toBe(2);
    expect(wrapper.children).toHaveLength(2);
  });
});

describe("TreeNode.ungroup", () => {
  it("reverses grouping to the original child order", () => {
    const parent = create("session");
    const a = parent.addChild({ id: "a", type: "turn" });
    parent.addChild({ id: "b", type: "turn" });
    parent.addChild({ id: "c", type: "turn" });
    const d = parent.addChild({ id: "d", type: "turn" });
    const wrapper = parent.groupChildren(1, 3, () => ({ type: "turn_group" }));

    parent.ungroup(wrapper);

    const ids = parent.children.map((c) => c.id);
    expect(ids).toEqual([a.id, "b", "c", d.id]);
  });

  it("throws when wrapper is not a direct child", () => {
    const parent = create("session");
    parent.addChild({ type: "turn" });
    const other: TreeNode = create("turn_group");
    expect(() => parent.ungroup(other)).toThrow(/not a direct child of this node/);
  });

  it("re-routes events back to parent after ungroup", () => {
    const parent = create("session");
    const a = parent.addChild({ id: "a", type: "turn" });
    parent.addChild({ id: "b", type: "turn" });
    const wrapper = parent.groupChildren(0, 2, () => ({ type: "turn_group" }));
    parent.ungroup(wrapper);

    const listener = vi.fn();
    parent.onUpdate(listener);
    a.touch();
    expect(listener).toHaveBeenCalled();
  });
});

describe("TreeNode grouping reversibility", () => {
  it("group + ungroup is a no-op on serialised form (modulo ids)", () => {
    const root = factory({ id: "root", type: "session", props: {} });
    root.addChild({ id: "a", type: "turn", props: {} });
    root.addChild({ id: "b", type: "turn", props: {} });
    root.addChild({ id: "c", type: "turn", props: {} });
    root.addChild({ id: "d", type: "turn", props: {} });

    const before = JSON.stringify(treeToJson(root));

    const wrapper = root.groupChildren(1, 3, () => ({
      id: "wrapper",
      type: "turn_group",
    }));
    root.ungroup(wrapper);

    const after = JSON.stringify(treeToJson(root));
    expect(after).toBe(before);
  });
});
