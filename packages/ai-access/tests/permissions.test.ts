// The permission language (statewalker/statewalker-root#77, extended by #157, #158, #160, #161):
// `area.action[:target]` with `*` as a whole segment, targets relative to the project, and the
// translation of permissions to Datalog, checked against a plain matcher by property-based tests.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type AccessRequest,
  decide,
  type Permission,
  parsePermissions,
  permits,
} from "../src/index.js";

const pairs = (perms: Permission[]) => perms.map((p) => `${p.area}.${p.action}`).sort();

describe("the permission language", () => {
  it("parses area.action with an optional target", () => {
    expect(parsePermissions(["files.write:/drafts/**", "tools.call:search", "db.read"])).toEqual({
      permissions: [
        { area: "files", action: "write", target: "/drafts/**" },
        { area: "tools", action: "call", target: "search" },
        { area: "db", action: "read" },
      ],
      problems: [],
    });
  });

  it("accepts the shapes later decisions added, before their features exist", () => {
    const { permissions, problems } = parsePermissions([
      "memory.write:project",
      "memory.write:agent",
      "usage.read:*",
      "limits.write:*",
      "triggers.write:own",
      "triggers.write:project",
      "tasks.publish:agents.*.reviewer.>",
      "tasks.subscribe:>",
      "tasks.admin",
      "net.read:api.example.com/v1",
      "net.write:*.example.com",
      "agents.use:remote/claude",
      "members.manage",
      "models.use:fast",
      "comments.write",
    ]);
    expect(problems).toEqual([]);
    expect(permissions).toHaveLength(15);
  });

  it("expands net.fetch to net.read and net.write on the same host", () => {
    expect(parsePermissions(["net.fetch:api.example.com"]).permissions).toEqual([
      { area: "net", action: "read", target: "api.example.com" },
      { area: "net", action: "write", target: "api.example.com" },
    ]);
  });

  it("expands * over the known areas and actions, never to the permissions only named ones grant", () => {
    const all = parsePermissions(["*.*"]).permissions;
    expect(pairs(all)).toContain("files.delete");
    expect(pairs(all)).toContain("tasks.admin");
    expect(pairs(all)).toContain("members.manage");
    // Network, remote agents and creating projects are granted only by name.
    for (const named of ["net.read", "net.write", "agents.use", "projects.create"])
      expect(pairs(all)).not.toContain(named);
    expect(pairs(parsePermissions(["files.*"]).permissions)).toEqual([
      "files.delete",
      "files.list",
      "files.read",
      "files.write",
    ]);
    expect(pairs(parsePermissions(["*.read"]).permissions)).not.toContain("net.read");
    expect(pairs(parsePermissions(["net.*"]).permissions)).toEqual(["net.read", "net.write"]);
  });

  it("reports and ignores an unknown area or action, never treating it as everything", () => {
    const { permissions, problems } = parsePermissions([
      "frobs.read",
      "files.zap",
      "files",
      "files.read:",
      "Files.read",
      "fi*.read",
      "files.read:/ok/**",
    ]);
    expect(permissions).toEqual([{ area: "files", action: "read", target: "/ok/**" }]);
    expect(problems).toHaveLength(6);
    expect(
      decide([{ role: "odd", permissions, checks: [] }], {
        area: "files",
        action: "read",
        target: "/x",
      }),
    ).toBe(false);
  });
});

describe("deciding with roles", () => {
  const role = (entries: string[], checks: string[] = []) => ({
    role: "r",
    permissions: parsePermissions(entries).permissions,
    checks,
  });

  it("matches file targets relative to the project, with * in a segment and ** across segments", () => {
    const r = role(["files.read:/drafts/**", "files.list:/docs/*.md"]);
    const ok = (action: string, target: string) => decide([r], { area: "files", action, target });
    expect(ok("read", "/drafts")).toBe(true);
    expect(ok("read", "/drafts/a/b.md")).toBe(true);
    expect(ok("read", "/draftsman/x")).toBe(false);
    expect(ok("read", "/readme.md")).toBe(false);
    expect(ok("list", "/docs/a.md")).toBe(true);
    expect(ok("list", "/docs/sub/a.md")).toBe(false);
    expect(ok("write", "/drafts/a.md")).toBe(false);
  });

  it("matches task subjects with * for one token and > for the rest, and hosts with subdomain wildcards", () => {
    const r = role(["tasks.publish:agents.*.reviewer.>", "net.read:*.example.com/v1"]);
    expect(
      decide([r], { area: "tasks", action: "publish", target: "agents.p.reviewer.done" }),
    ).toBe(true);
    expect(decide([r], { area: "tasks", action: "publish", target: "agents.p.q.reviewer.x" })).toBe(
      false,
    );
    expect(decide([r], { area: "tasks", action: "publish", target: "agents.p.reviewer" })).toBe(
      false,
    );
    expect(decide([r], { area: "net", action: "read", target: "api.example.com/v1/x" })).toBe(true);
    expect(decide([r], { area: "net", action: "read", target: "a.b.example.com/v1" })).toBe(true);
    expect(decide([r], { area: "net", action: "read", target: "example.com/v1" })).toBe(false);
    expect(decide([r], { area: "net", action: "read", target: "api.example.com/v2" })).toBe(false);
    expect(decide([r], { area: "net", action: "read", target: "evil.com/x.example.com/v1" })).toBe(
      false,
    );
  });

  it("lets a role's Datalog only narrow what its permissions grant", () => {
    const narrowed = role(["files.read"], ['check if target($t), !$t.starts_with("/private");']);
    expect(decide([narrowed], { area: "files", action: "read", target: "/notes.md" })).toBe(true);
    expect(decide([narrowed], { area: "files", action: "read", target: "/private/x" })).toBe(false);
    // A role with checks and no permissions grants nothing.
    expect(
      decide([role([], ["check if true;"])], { area: "files", action: "read", target: "/a" }),
    ).toBe(false);
  });

  it("applies a role's checks to that role only: another role the user holds still grants", () => {
    const narrowed = role(["files.read"], ['check if target($t), !$t.starts_with("/private");']);
    const other = role(["files.read:/private/**"]);
    expect(decide([narrowed, other], { area: "files", action: "read", target: "/private/x" })).toBe(
      true,
    );
  });
});

// Generators over small alphabets, so patterns and targets often meet.
const seg = fc.constantFrom("a", "b", "ab", "x.md", "*", "a*", "*.md");
const pathPattern = fc
  .array(fc.oneof(seg, fc.constant("**")), { maxLength: 4 })
  .map((s) => `/${s.join("/")}`);
const path = fc
  .array(fc.constantFrom("a", "b", "ab", "x.md", "y.md", "ba"), { maxLength: 5 })
  .map((s) => `/${s.join("/")}`);
const token = fc.constantFrom("agents", "p", "reviewer", "hooks", "x");
const subjectPattern = fc
  .tuple(fc.array(fc.oneof(token, fc.constant("*")), { maxLength: 3 }), fc.boolean())
  .map(([t, tail]) => [...t, ...(tail || t.length === 0 ? [">"] : [])].join("."));
const subject = fc.array(token, { minLength: 1, maxLength: 5 }).map((t) => t.join("."));
const host = fc.constantFrom("example.com", "api.example.com", "a.b.example.com", "evil.com");
const hostPattern = fc
  .tuple(
    fc.constantFrom("example.com", "*.example.com", "api.example.com"),
    fc.constantFrom("", "/v1", "/v1/x"),
  )
  .map(([h, p]) => h + p);
const url = fc
  .tuple(host, fc.constantFrom("", "/v1", "/v1/x", "/v10", "/v1/x/y"))
  .map(([h, p]) => h + p);
const name = fc.constantFrom("search", "s*", "*", "*arch", "plugin/tool", "plugin/*");
const nameTarget = fc.constantFrom("search", "sea", "plugin/tool", "plugin/x", "other");

const filesPerm = fc.record({
  area: fc.constant("files"),
  action: fc.constantFrom("read", "list", "*"),
  target: fc.option(pathPattern, { nil: undefined }),
});
const tasksPerm = fc.record({
  area: fc.constant("tasks"),
  action: fc.constantFrom("publish", "subscribe"),
  target: fc.option(subjectPattern, { nil: undefined }),
});
const netPerm = fc.record({
  area: fc.constant("net"),
  action: fc.constantFrom("read", "write", "fetch"),
  target: fc.option(hostPattern, { nil: undefined }),
});
const toolsPerm = fc.record({
  area: fc.constantFrom("tools", "*"),
  action: fc.constantFrom("call", "*"),
  target: fc.option(name, { nil: undefined }),
});
const text = (p: { area: string; action: string; target?: string }) =>
  `${p.area}.${p.action}${p.target === undefined ? "" : `:${p.target}`}`;

const requests = fc.oneof(
  fc.record({ area: fc.constant("files"), action: fc.constantFrom("read", "list"), target: path }),
  fc.record({
    area: fc.constant("tasks"),
    action: fc.constantFrom("publish", "subscribe"),
    target: subject,
  }),
  fc.record({ area: fc.constant("net"), action: fc.constantFrom("read", "write"), target: url }),
  fc.record({ area: fc.constant("tools"), action: fc.constant("call"), target: nameTarget }),
);
const permissionTexts = fc.array(fc.oneof(filesPerm, tasksPerm, netPerm, toolsPerm).map(text), {
  maxLength: 4,
});

describe("the translation of permissions to Datalog (property-based)", () => {
  it("decides exactly as the plain matcher does, for every kind of target", () => {
    fc.assert(
      fc.property(permissionTexts, requests, (texts, req: AccessRequest) => {
        const { permissions } = parsePermissions(texts);
        const viaDatalog = decide([{ role: "r", permissions, checks: [] }], req);
        expect(viaDatalog).toBe(permits(permissions, req));
      }),
      { numRuns: 1000 },
    );
  });

  it("never grants through an unknown area or action, whatever else the role holds", () => {
    const unknown = fc
      .tuple(fc.constantFrom("frobs", "file", "FILES", "x"), fc.constantFrom("read", "zap", "*"))
      .map(([a, c]) => `${a}.${c}`);
    fc.assert(
      fc.property(fc.array(unknown, { minLength: 1, maxLength: 3 }), requests, (texts, req) => {
        const { permissions, problems } = parsePermissions(texts);
        expect(problems).toHaveLength(texts.length);
        expect(decide([{ role: "r", permissions, checks: [] }], req)).toBe(false);
      }),
    );
  });

  it("a permission without a target covers every target of its area and action", () => {
    fc.assert(
      fc.property(requests, (req) => {
        const { permissions } = parsePermissions([`${req.area}.${req.action}`]);
        expect(decide([{ role: "r", permissions, checks: [] }], req)).toBe(true);
      }),
    );
  });

  it("adding a check to a role never widens it", () => {
    const check = fc.constantFrom(
      "check if true;",
      "check if false;",
      'check if target($t), $t.starts_with("/a");',
      'check if operation($a, $c), $c == "read";',
    );
    fc.assert(
      fc.property(permissionTexts, check, requests, (texts, c, req) => {
        const { permissions } = parsePermissions(texts);
        const narrowed = decide([{ role: "r", permissions, checks: [c] }], req);
        if (narrowed) expect(decide([{ role: "r", permissions, checks: [] }], req)).toBe(true);
      }),
    );
  });
});
