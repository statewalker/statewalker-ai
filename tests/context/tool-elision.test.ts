import { describe, expect, it } from "vitest";
import {
  createDefaultElisionPolicy,
  elideToolResponse,
  type ToolElisionPolicy,
} from "../../src/context/tool-elision.js";

function policyWith(partial: Partial<ToolElisionPolicy>): ToolElisionPolicy {
  const base = createDefaultElisionPolicy();
  return { ...base, ...partial };
}

describe("elideToolResponse", () => {
  it("passes content through unchanged under the minElideChars threshold", () => {
    const policy = createDefaultElisionPolicy({ minElideChars: 2000 });
    const content = "a".repeat(500);
    expect(
      elideToolResponse(content, "unknown_tool", { foo: 1 }, policy),
    ).toBe(content);
  });

  it("never-elide strategy keeps content intact regardless of length", () => {
    const policy = createDefaultElisionPolicy();
    const content = "x".repeat(10_000);
    expect(
      elideToolResponse(content, "use_skills", { q: "…" }, policy),
    ).toBe(content);
  });

  it("head-tail keeps the configured boundaries and shows elision count", () => {
    const policy = policyWith({
      minElideChars: 500,
      defaultStrategy: { kind: "head-tail", headChars: 10, tailChars: 10 },
      perTool: new Map(),
    });
    const head = "H".repeat(10);
    const tail = "T".repeat(10);
    const middle = "M".repeat(9_980);
    const content = head + middle + tail;
    const out = elideToolResponse(content, "anything", {}, policy);
    expect(out.startsWith(head)).toBe(true);
    expect(out.endsWith(tail)).toBe(true);
    expect(out).toContain("…elided 9980 chars…");
  });

  it("placeholder-only emits marker with N chars, tool, and arg keys", () => {
    const policy = policyWith({
      minElideChars: 500,
      defaultStrategy: { kind: "placeholder-only" },
      perTool: new Map(),
    });
    const content = "x".repeat(10_000);
    const out = elideToolResponse(
      content,
      "read_file",
      { path: "/a", limit: 5 },
      policy,
    );
    expect(out).toBe(
      "[result elided — 10000 chars, call read_file with args {path, limit}]",
    );
  });

  it("unregistered tool uses the policy default", () => {
    const policy = policyWith({
      minElideChars: 500,
      defaultStrategy: { kind: "placeholder-only" },
      perTool: new Map(),
    });
    const content = "y".repeat(5000);
    const out = elideToolResponse(content, "unknown_tool", {}, policy);
    expect(out.startsWith("[result elided — 5000 chars, call unknown_tool")).toBe(
      true,
    );
  });

  it("default registry pins stateful tools to never-elide", () => {
    const policy = createDefaultElisionPolicy();
    const content = "z".repeat(50_000);
    for (const tool of ["list_tools", "list_skills", "use_skills"]) {
      expect(elideToolResponse(content, tool, {}, policy)).toBe(content);
    }
  });

  it("neverElidePattern makes matching tools never elide", () => {
    const policy = createDefaultElisionPolicy({
      neverElidePattern: /_state$/,
    });
    const content = "x".repeat(10_000);
    expect(elideToolResponse(content, "session_state", {}, policy)).toBe(
      content,
    );
  });

  it("head-tail leaves content intact when shorter than head+tail", () => {
    const policy = policyWith({
      minElideChars: 5,
      defaultStrategy: { kind: "head-tail", headChars: 50, tailChars: 50 },
      perTool: new Map(),
    });
    const content = "a".repeat(80);
    expect(elideToolResponse(content, "anything", {}, policy)).toBe(content);
  });
});
