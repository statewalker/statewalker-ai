import { SNOWFLAKE_BASE32_LENGTH, SnowflakeId } from "@statewalker/shared-ids";
import { describe, expect, it, vi } from "vitest";
import { newNodeFactory } from "../src/node-factory.js";
import { TreeNode } from "../src/tree-node.js";

const factory = newNodeFactory({});

function create(type: string, extra?: Record<string, unknown>) {
  return factory({ type, props: extra });
}

describe("TreeNode construction", () => {
  it("generates Crockford base32 ID (13 chars)", () => {
    const node = create("test");
    expect(node.id).toHaveLength(SNOWFLAKE_BASE32_LENGTH);
    expect(node.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{13}$/);
  });

  it("type comes from props.type", () => {
    const node = create("turn");
    expect(node.type).toBe("turn");
    expect(node.props.type).toBe("turn");
  });

  it("defaults type to 'message' when props.type is absent", () => {
    const node = factory({ id: "test1", props: {} });
    expect(node.type).toBe("message");
  });

  it("delegates content to data", () => {
    const node = factory({ type: "msg", content: "hello" });
    expect(node.content).toBe("hello");
    node.content = "updated";
    expect(node.data.content).toBe("updated");
  });
});

describe("parentId", () => {
  it("returns parent id when attached", () => {
    const parent = create("session");
    const child = parent.addChild({ type: "turn" });
    expect(child.parentId).toBe(parent.id);
  });

  it("returns undefined for root", () => {
    expect(create("session").parentId).toBeUndefined();
  });
});

describe("createdAt / updatedAt / touch", () => {
  it("createdAt from Snowflake ID", () => {
    const time = 1700000000000;
    const idGen = new SnowflakeId({ now: () => time });
    const node = factory({ id: idGen.generate(), type: "test", props: {} });
    expect(node.createdAt.getTime()).toBe(time);
  });

  it("updatedAt falls back to createdAt", () => {
    const time = 1700000000000;
    const idGen = new SnowflakeId({ now: () => time });
    const node = factory({ id: idGen.generate(), type: "test", props: {} });
    expect(node.updatedAt.getTime()).toBe(time);
  });

  it("updatedAt reads ISO string from props", () => {
    const iso = "2024-01-15T12:00:00.000Z";
    const node = factory({ type: "test", props: { updatedAt: iso } });
    expect(node.updatedAt.toISOString()).toBe(iso);
  });

  it("touch sets props.updatedAt as ISO string", () => {
    const node = create("test");
    node.touch();
    expect(node.props.updatedAt).toBeTypeOf("string");
    expect(new Date(node.props.updatedAt as string).getTime()).toBeGreaterThan(0);
  });

  it("touch bubbles up", () => {
    const parent = create("session");
    const child = parent.addChild({ type: "turn" });
    const listener = vi.fn();
    parent.onUpdate(listener);
    child.touch();
    expect(listener).toHaveBeenCalled();
  });
});

describe("children (cached wrappers)", () => {
  it("addChild creates wrapper and caches it", () => {
    const parent = create("session");
    const child = parent.addChild({ type: "turn" });
    expect(child).toBeInstanceOf(TreeNode);
    expect(child.parent).toBe(parent);
    expect(parent.children).toHaveLength(1);
    expect(parent.children[0]).toBe(child);
  });

  it("children returns same cached instances", () => {
    const parent = create("session");
    parent.addChild({ type: "turn" });
    const first = parent.children;
    const second = parent.children;
    expect(first[0]).toBe(second[0]);
  });

  it("addChild notifies parent", () => {
    const parent = create("session");
    const listener = vi.fn();
    parent.onUpdate(listener);
    parent.addChild({ type: "turn" });
    expect(listener).toHaveBeenCalled();
  });

  it("removeChild clears cache and parent", () => {
    const parent = create("session");
    const child = parent.addChild({ type: "turn" });
    parent.removeChild(child);
    expect(child.parent).toBeUndefined();
    expect(parent.children).toHaveLength(0);
  });

  it("removeChild stops bubbleUp", () => {
    const parent = create("session");
    const child = parent.addChild({ type: "turn" });
    parent.removeChild(child);
    const listener = vi.fn();
    parent.onUpdate(listener);
    child.bubbleUp();
    expect(listener).not.toHaveBeenCalled();
  });

  it("uses factory to create typed children", () => {
    class MyTurn extends TreeNode {}
    const customFactory = newNodeFactory({ turn: MyTurn });

    const parent = customFactory({ id: "root", type: "session", props: {} });
    const child = parent.addChild({ type: "turn" });
    expect(child).toBeInstanceOf(MyTurn);
  });

  it("data.children stays in sync", () => {
    const parent = create("session");
    parent.addChild({ type: "turn" });
    parent.addChild({ type: "turn" });
    expect(parent.data.children).toHaveLength(2);
  });
});

describe("bubbleUp", () => {
  it("propagates through levels", () => {
    const root = create("session");
    const mid = root.addChild({ type: "turn" });
    const leaf = mid.addChild({ type: "msg" });
    const rootListener = vi.fn();
    root.onUpdate(rootListener);
    leaf.bubbleUp();
    expect(rootListener).toHaveBeenCalled();
  });
});

describe("visit", () => {
  it("traverses depth-first", () => {
    const root = factory({ id: "root", type: "session", props: {} });
    const c1 = root.addChild({ id: "c1", type: "turn", props: {} });
    root.addChild({ id: "c2", type: "turn", props: {} });
    c1.addChild({ id: "gc1", type: "msg", props: {} });

    const ids: string[] = [];
    root.visit((e) => {
      ids.push(e.id);
      return undefined;
    });
    expect(ids).toEqual(["root", "c1", "gc1", "c2"]);
  });

  it("skips children when begin returns false", () => {
    const root = factory({ id: "root", type: "session", props: {} });
    const c1 = root.addChild({ id: "c1", type: "turn", props: {} });
    c1.addChild({ id: "gc1", type: "msg", props: {} });

    const ids: string[] = [];
    root.visit((e) => {
      ids.push(e.id);
      if (e.id === "c1") return false;
      return undefined;
    });
    expect(ids).toEqual(["root", "c1"]);
  });

  it("begin receives TreeEntry shape (no parent)", () => {
    const node = factory({
      type: "test",
      props: { key: "value" },
      content: "hello",
    });
    let received: unknown;
    node.visit((e) => {
      received = e;
      return undefined;
    });
    expect(received).toHaveProperty("id");
    expect(received).toHaveProperty("props");
    expect(received).toHaveProperty("content", "hello");
    expect(received).not.toHaveProperty("parent");
  });
});

describe("childrenOfType", () => {
  it("filters by props.type", () => {
    const parent = create("turn");
    parent.addChild({ type: "user_message", content: "hi" });
    parent.addChild({ type: "agent_message", content: "hey" });
    parent.addChild({ type: "tool_call" });

    expect(parent.childrenOfType("user_message")).toHaveLength(1);
    expect(parent.childrenOfType("tool_call")).toHaveLength(1);
    expect(parent.childrenOfType("nonexistent")).toHaveLength(0);
  });
});

describe("lexicographic ID ordering", () => {
  it("IDs are chronologically sortable", () => {
    const nodes: TreeNode[] = [];
    for (let i = 0; i < 10; i++) {
      nodes.push(create("test"));
    }
    const ids = nodes.map((e) => e.id);
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
  });
});
