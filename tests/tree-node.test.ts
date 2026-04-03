import { SNOWFLAKE_BASE32_LENGTH, SnowflakeId } from "@repo/ids";
import { describe, expect, it, vi } from "vitest";
import { createEntry, TreeNode } from "../src/tree-node.js";
import type { NodeFactory, TreeEntry } from "../src/types.js";

const defaultFactory: NodeFactory = (data) => new TreeNode(data);

function entry(type: string, overrides: Partial<TreeEntry> = {}): TreeEntry {
  return createEntry({ type, ...overrides });
}

describe("TreeNode construction", () => {
  it("wraps a TreeEntry with Snowflake ID", () => {
    const data = entry("test");
    const node = new TreeNode(data, defaultFactory);
    expect(node.id).toHaveLength(SNOWFLAKE_BASE32_LENGTH);
    expect(node.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{13}$/);
    expect(node.id).toBe(data.id);
  });

  it("type comes from props.type", () => {
    const data = entry("turn");
    const node = new TreeNode(data, defaultFactory);
    expect(node.type).toBe("turn");
    expect(node.props.type).toBe("turn");
  });

  it("defaults type to 'message' when props.type is absent", () => {
    const data: TreeEntry = { id: "test1", props: {} };
    const node = new TreeNode(data, defaultFactory);
    expect(node.type).toBe("message");
  });

  it("delegates content to data", () => {
    const data = entry("msg", { content: "hello" });
    const node = new TreeNode(data, defaultFactory);
    expect(node.content).toBe("hello");
    node.content = "updated";
    expect(data.content).toBe("updated");
  });
});

describe("parentId", () => {
  it("returns parent id when attached", () => {
    const parent = new TreeNode(entry("session"), defaultFactory);
    const child = parent.addChild(entry("turn"));
    expect(child.parentId).toBe(parent.id);
  });

  it("returns undefined for root", () => {
    const root = new TreeNode(entry("session"), defaultFactory);
    expect(root.parentId).toBeUndefined();
  });
});

describe("createdAt / updatedAt / touch", () => {
  it("createdAt from Snowflake ID", () => {
    const time = 1700000000000;
    const idGen = new SnowflakeId({ now: () => time });
    const data = createEntry({ type: "test", idGen });
    const node = new TreeNode(data, defaultFactory);
    expect(node.createdAt.getTime()).toBe(time);
  });

  it("updatedAt falls back to createdAt", () => {
    const time = 1700000000000;
    const idGen = new SnowflakeId({ now: () => time });
    const data = createEntry({ type: "test", idGen });
    const node = new TreeNode(data, defaultFactory);
    expect(node.updatedAt.getTime()).toBe(time);
  });

  it("updatedAt reads ISO string from props", () => {
    const iso = "2024-01-15T12:00:00.000Z";
    const data = entry("test", { props: { type: "test", updatedAt: iso } });
    const node = new TreeNode(data, defaultFactory);
    expect(node.updatedAt.toISOString()).toBe(iso);
  });

  it("touch sets props.updatedAt as ISO string", () => {
    const node = new TreeNode(entry("test"), defaultFactory);
    node.touch();
    expect(node.props.updatedAt).toBeTypeOf("string");
    expect(new Date(node.props.updatedAt as string).getTime()).toBeGreaterThan(
      0,
    );
  });

  it("touch bubbles up", () => {
    const parent = new TreeNode(entry("session"), defaultFactory);
    const child = parent.addChild(entry("turn"));
    const listener = vi.fn();
    parent.onUpdate(listener);
    child.touch();
    expect(listener).toHaveBeenCalled();
  });
});

describe("children (cached wrappers)", () => {
  it("addChild creates wrapper and caches it", () => {
    const parent = new TreeNode(entry("session"), defaultFactory);
    const child = parent.addChild(entry("turn"));
    expect(child).toBeInstanceOf(TreeNode);
    expect(child.parent).toBe(parent);
    expect(parent.children).toHaveLength(1);
    expect(parent.children[0]).toBe(child);
  });

  it("children returns same cached instances", () => {
    const parent = new TreeNode(entry("session"), defaultFactory);
    parent.addChild(entry("turn"));
    const first = parent.children;
    const second = parent.children;
    expect(first[0]).toBe(second[0]); // same object, cached
  });

  it("addChild notifies parent", () => {
    const parent = new TreeNode(entry("session"), defaultFactory);
    const listener = vi.fn();
    parent.onUpdate(listener);
    parent.addChild(entry("turn"));
    expect(listener).toHaveBeenCalled();
  });

  it("removeChild clears cache and parent", () => {
    const parent = new TreeNode(entry("session"), defaultFactory);
    const child = parent.addChild(entry("turn"));
    parent.removeChild(child);
    expect(child.parent).toBeUndefined();
    expect(parent.children).toHaveLength(0);
  });

  it("removeChild stops bubbleUp", () => {
    const parent = new TreeNode(entry("session"), defaultFactory);
    const child = parent.addChild(entry("turn"));
    parent.removeChild(child);
    const listener = vi.fn();
    parent.onUpdate(listener);
    child.bubbleUp();
    expect(listener).not.toHaveBeenCalled();
  });

  it("uses factory to create typed children", () => {
    class MyTurn extends TreeNode {}
    const customFactory: NodeFactory = (data) => {
      const type = (data.props.type as string) ?? "message";
      if (type === "turn") return new MyTurn(data, customFactory);
      return new TreeNode(data, customFactory);
    };

    const parent = new TreeNode(entry("session"), customFactory);
    const child = parent.addChild(entry("turn"));
    expect(child).toBeInstanceOf(MyTurn);
  });

  it("data.children stays in sync", () => {
    const parent = new TreeNode(entry("session"), defaultFactory);
    parent.addChild(entry("turn"));
    parent.addChild(entry("turn"));
    expect(parent.data.children).toHaveLength(2);
  });
});

describe("bubbleUp", () => {
  it("propagates through levels", () => {
    const root = new TreeNode(entry("session"), defaultFactory);
    const mid = root.addChild(entry("turn"));
    const leaf = mid.addChild(entry("msg"));

    const rootListener = vi.fn();
    root.onUpdate(rootListener);
    leaf.bubbleUp();
    expect(rootListener).toHaveBeenCalled();
  });
});

describe("visit", () => {
  it("traverses depth-first", () => {
    const root = new TreeNode(entry("session", { id: "root" }), defaultFactory);
    const c1 = root.addChild(entry("turn", { id: "c1" }));
    root.addChild(entry("turn", { id: "c2" }));
    c1.addChild(entry("msg", { id: "gc1" }));

    const ids: string[] = [];
    root.visit((e) => {
      ids.push(e.id);
      return undefined;
    });
    expect(ids).toEqual(["root", "c1", "gc1", "c2"]);
  });

  it("skips children when begin returns false", () => {
    const root = new TreeNode(entry("session", { id: "root" }), defaultFactory);
    const c1 = root.addChild(entry("turn", { id: "c1" }));
    c1.addChild(entry("msg", { id: "gc1" }));

    const ids: string[] = [];
    root.visit((e) => {
      ids.push(e.id);
      if (e.id === "c1") return false;
      return undefined;
    });
    expect(ids).toEqual(["root", "c1"]);
  });
});

describe("childrenOfType", () => {
  it("filters by props.type", () => {
    const parent = new TreeNode(entry("turn"), defaultFactory);
    parent.addChild(entry("user_message"));
    parent.addChild(entry("agent_message"));
    parent.addChild(entry("tool_call"));

    expect(parent.childrenOfType("user_message")).toHaveLength(1);
    expect(parent.childrenOfType("tool_call")).toHaveLength(1);
    expect(parent.childrenOfType("nonexistent")).toHaveLength(0);
  });
});
