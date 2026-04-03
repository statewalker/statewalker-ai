import { SNOWFLAKE_BASE32_LENGTH } from "@repo/ids";
import { describe, expect, it, vi } from "vitest";
import { TreeEntry } from "../src/tree-entry.js";

describe("TreeEntry construction", () => {
  it("generates Crockford base32 ID (13 chars)", () => {
    const entry = new TreeEntry("test");
    expect(entry.id).toHaveLength(SNOWFLAKE_BASE32_LENGTH);
    expect(entry.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{13}$/);
  });

  it("accepts custom id", () => {
    const entry = new TreeEntry("test", { id: "CUSTOM0000001" });
    expect(entry.id).toBe("CUSTOM0000001");
  });

  it("sets type and props", () => {
    const entry = new TreeEntry("turn", { props: { turnNumber: 1 } });
    expect(entry.type).toBe("turn");
    expect(entry.props.turnNumber).toBe(1);
  });

  it("sets content", () => {
    const entry = new TreeEntry("message", { content: "hello" });
    expect(entry.content).toBe("hello");
  });

  it("defaults props to empty object", () => {
    const entry = new TreeEntry("test");
    expect(entry.props).toEqual({});
  });
});

describe("parentId getter", () => {
  it("returns parent id when attached", () => {
    const parent = new TreeEntry("session");
    const child = new TreeEntry("turn");
    parent.addChild(child);
    expect(child.parentId).toBe(parent.id);
  });

  it("returns undefined for root", () => {
    const root = new TreeEntry("session");
    expect(root.parentId).toBeUndefined();
  });

  it("returns undefined after detach", () => {
    const parent = new TreeEntry("session");
    const child = new TreeEntry("turn");
    parent.addChild(child);
    parent.removeChild(child);
    expect(child.parentId).toBeUndefined();
  });
});

describe("addChild / removeChild", () => {
  it("addChild sets parent reference", () => {
    const parent = new TreeEntry("session");
    const child = new TreeEntry("turn");
    parent.addChild(child);
    expect(child.parent).toBe(parent);
  });

  it("addChild appends to children array", () => {
    const parent = new TreeEntry("session");
    const c1 = new TreeEntry("turn");
    const c2 = new TreeEntry("turn");
    parent.addChild(c1);
    parent.addChild(c2);
    expect(parent.children).toHaveLength(2);
    expect(parent.children).toEqual([c1, c2]);
  });

  it("addChild creates new array reference (immutable)", () => {
    const parent = new TreeEntry("session");
    const c1 = new TreeEntry("turn");
    parent.addChild(c1);
    const ref1 = parent.children;
    const c2 = new TreeEntry("turn");
    parent.addChild(c2);
    expect(parent.children).not.toBe(ref1);
  });

  it("addChild notifies parent listeners", () => {
    const parent = new TreeEntry("session");
    const listener = vi.fn();
    parent.onUpdate(listener);
    parent.addChild(new TreeEntry("turn"));
    expect(listener).toHaveBeenCalled();
  });

  it("removeChild clears parent reference", () => {
    const parent = new TreeEntry("session");
    const child = new TreeEntry("turn");
    parent.addChild(child);
    parent.removeChild(child);
    expect(child.parent).toBeUndefined();
  });

  it("removeChild removes from children", () => {
    const parent = new TreeEntry("session");
    const c1 = new TreeEntry("turn");
    const c2 = new TreeEntry("turn");
    parent.addChild(c1);
    parent.addChild(c2);
    parent.removeChild(c1);
    expect(parent.children).toEqual([c2]);
  });
});

describe("bubbleUp", () => {
  it("notifies parent listener on child change", () => {
    const parent = new TreeEntry("session");
    const child = new TreeEntry("turn");
    parent.addChild(child);

    const listener = vi.fn();
    parent.onUpdate(listener);
    child.bubbleUp();
    expect(listener).toHaveBeenCalled();
  });

  it("propagates through multiple levels", () => {
    const root = new TreeEntry("session");
    const mid = new TreeEntry("turn");
    const leaf = new TreeEntry("message");
    root.addChild(mid);
    mid.addChild(leaf);

    const rootListener = vi.fn();
    const midListener = vi.fn();
    root.onUpdate(rootListener);
    mid.onUpdate(midListener);

    leaf.bubbleUp();
    expect(midListener).toHaveBeenCalled();
    expect(rootListener).toHaveBeenCalled();
  });

  it("does not propagate after removeChild", () => {
    const parent = new TreeEntry("session");
    const child = new TreeEntry("turn");
    parent.addChild(child);
    parent.removeChild(child);

    const listener = vi.fn();
    parent.onUpdate(listener);
    child.bubbleUp();
    expect(listener).not.toHaveBeenCalled();
  });

  it("stops at root without error", () => {
    const root = new TreeEntry("session");
    const listener = vi.fn();
    root.onUpdate(listener);
    root.bubbleUp();
    expect(listener).toHaveBeenCalledOnce();
  });
});

describe("visit", () => {
  it("traverses depth-first", () => {
    const root = new TreeEntry("session", { id: "root" });
    const c1 = new TreeEntry("turn", { id: "c1" });
    const c2 = new TreeEntry("turn", { id: "c2" });
    const gc1 = new TreeEntry("msg", { id: "gc1" });
    const gc2 = new TreeEntry("msg", { id: "gc2" });
    root.addChild(c1);
    root.addChild(c2);
    c1.addChild(gc1);
    c2.addChild(gc2);

    const begins: string[] = [];
    const ends: string[] = [];
    root.visit(
      (node) => {
        begins.push(node.id);
      },
      () => {
        ends.push("end");
      },
    );

    expect(begins).toEqual(["root", "c1", "gc1", "c2", "gc2"]);
    expect(ends).toHaveLength(5);
  });

  it("skips children when begin returns false", () => {
    const root = new TreeEntry("session", { id: "root" });
    const child = new TreeEntry("turn", { id: "child" });
    const grandchild = new TreeEntry("msg", { id: "gc" });
    root.addChild(child);
    child.addChild(grandchild);

    const visited: string[] = [];
    let endCount = 0;
    root.visit(
      (node) => {
        visited.push(node.id);
        if (node.id === "child") return false;
      },
      () => {
        endCount++;
      },
    );

    expect(visited).toEqual(["root", "child"]);
    expect(endCount).toBe(2); // root end + child end (skipped gc)
  });

  it("begin receives TreeNode shape (no parent, no methods)", () => {
    const entry = new TreeEntry("test", {
      props: { key: "value" },
      content: "hello",
    });

    let received: unknown;
    entry.visit((node) => {
      received = node;
    });

    expect(received).toHaveProperty("id");
    expect(received).toHaveProperty("type", "test");
    expect(received).toHaveProperty("props", { key: "value" });
    expect(received).toHaveProperty("content", "hello");
    expect(received).not.toHaveProperty("parent");
    expect(received).not.toHaveProperty("bubbleUp");
  });

  it("omits content when undefined", () => {
    const entry = new TreeEntry("test");
    let received: Record<string, unknown> = {};
    entry.visit((node) => {
      received = node as Record<string, unknown>;
    });
    expect("content" in received).toBe(false);
  });

  it("omits children when empty", () => {
    const entry = new TreeEntry("test");
    let received: Record<string, unknown> = {};
    entry.visit((node) => {
      received = node as Record<string, unknown>;
    });
    expect("children" in received).toBe(false);
  });
});

describe("lexicographic ID ordering", () => {
  it("IDs are chronologically sortable", () => {
    const entries: TreeEntry[] = [];
    for (let i = 0; i < 10; i++) {
      entries.push(new TreeEntry("test"));
    }
    const ids = entries.map((e) => e.id);
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
  });
});
