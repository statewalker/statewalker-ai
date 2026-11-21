// Roles (statewalker/statewalker-root#77): built-in owner, editor and reader per project, the
// workspace admin, custom roles composed with `role:`, and the role sources that hold them.
import { describe, expect, it } from "vitest";
import {
  type AccessRequest,
  accessOf,
  chainRoleSources,
  decide,
  fileRoleSource,
  type RoleSource,
  resolveRoles,
} from "../src/index.js";

const can = (grants: Parameters<typeof decide>[0], area: string, action: string, target?: string) =>
  decide(grants, { area, action, target } as AccessRequest);

describe("built-in roles", () => {
  it("grant owner everything in the project, editor the working set and reader reading", () => {
    const { grants: owner } = resolveRoles(["owner"], {});
    const { grants: editor } = resolveRoles(["editor"], {});
    const { grants: reader } = resolveRoles(["reader"], {});
    for (const [area, action] of [
      ["files", "delete"],
      ["members", "manage"],
      ["tasks", "admin"],
      ["usage", "read"],
      ["limits", "write"],
    ] as const)
      expect(can(owner, area, action, "x")).toBe(true);
    for (const [area, action, target] of [
      ["files", "write", "/a"],
      ["comments", "write", "/a"],
      ["tools", "call", "search"],
      ["db", "admin", "main"],
      ["models", "use", "fast"],
      ["memory", "write", "project"],
      ["memory", "write", "agent"],
      ["triggers", "write", "own"],
      ["tasks", "publish", "jobs.build"],
    ] as const)
      expect(can(editor, area, action, target)).toBe(true);
    expect(can(editor, "members", "manage")).toBe(false);
    expect(can(editor, "triggers", "write", "project")).toBe(false);
    expect(can(editor, "tasks", "admin")).toBe(false);
    expect(can(reader, "files", "read", "/a")).toBe(true);
    expect(can(reader, "files", "list", "/")).toBe(true);
    expect(can(reader, "comments", "read", "/a")).toBe(true);
    for (const [area, action] of [
      ["files", "write"],
      ["comments", "write"],
      ["tools", "call"],
      ["memory", "write"],
      ["tasks", "publish"],
    ] as const)
      expect(can(reader, area, action, "x")).toBe(false);
  });

  it("keep the editor off the server-only task prefixes", () => {
    const { grants: editor } = resolveRoles(["editor"], {});
    expect(can(editor, "tasks", "publish", "hooks.deploy.received")).toBe(false);
    expect(can(editor, "tasks", "publish", "schedule.nightly")).toBe(false);
    expect(can(editor, "tasks", "subscribe", "jobs.>")).toBe(true);
  });

  it("give no built-in role the network or remote agents", () => {
    for (const role of ["owner", "editor", "reader", "admin"]) {
      const { grants } = resolveRoles([role], {});
      expect(can(grants, "net", "read", "example.com")).toBe(false);
      expect(can(grants, "net", "write", "example.com")).toBe(false);
      expect(can(grants, "agents", "use", "remote/claude")).toBe(false);
    }
  });

  it("let the workspace admin manage projects and members but not read files", () => {
    const { grants: admin } = resolveRoles(["admin"], {});
    expect(can(admin, "projects", "create")).toBe(true);
    expect(can(admin, "members", "manage")).toBe(true);
    expect(can(admin, "triggers", "write", "project")).toBe(true);
    expect(can(admin, "usage", "read", "workspace")).toBe(true);
    for (const action of ["read", "list", "write", "delete"])
      expect(can(admin, "files", action, "/a")).toBe(false);
  });
});

describe("custom roles", () => {
  it("compose with role: and add their own permissions", () => {
    const { grants, problems } = resolveRoles(["reviewer"], {
      reviewer: "role:reader, comments.write",
    });
    expect(problems).toEqual([]);
    expect(can(grants, "files", "read", "/a")).toBe(true);
    expect(can(grants, "comments", "write", "/a")).toBe(true);
    expect(can(grants, "files", "write", "/a")).toBe(false);
  });

  it("inherit the restrictions of the roles they include", () => {
    const defs = {
      "public-reader": ["role:reader", 'check if target($t), !$t.starts_with("/private");'],
      reviewer: "role:public-reader, comments.write",
    };
    const { grants } = resolveRoles(["reviewer"], defs);
    expect(can(grants, "files", "read", "/notes.md")).toBe(true);
    expect(can(grants, "files", "read", "/private/x")).toBe(false);
    expect(can(grants, "comments", "write", "/private/x")).toBe(false);
  });

  it("accept only checks as Datalog: a fact, rule or policy in a role is reported and ignored", () => {
    const { grants, problems } = resolveRoles(["sneaky"], {
      sneaky: [
        'grant_any("files", "read");',
        "grant_any($a, $c) <- operation($a, $c);",
        "allow if true;",
        "check if true; allow if true;",
        "files.list",
      ],
    });
    expect(problems).toHaveLength(4);
    expect(can(grants, "files", "read", "/a")).toBe(false);
    expect(can(grants, "files", "list", "/a")).toBe(true);
  });

  it("report a cycle and grant nothing through the roles in it", () => {
    const { grants, problems } = resolveRoles(["a", "c"], {
      a: ["role:b", "files.read"],
      b: ["role:a"],
      c: ["files.list"],
    });
    expect(problems.join("\n")).toMatch(/cycle/);
    expect(can(grants, "files", "read", "/x")).toBe(false);
    expect(can(grants, "files", "list", "/x")).toBe(true);
  });

  it("report an unknown role and a custom role that would redefine a built-in one", () => {
    const { grants, problems } = resolveRoles(["reader", "ghost"], { reader: "*.*" });
    expect(problems).toHaveLength(2);
    expect(can(grants, "files", "read", "/a")).toBe(true);
    expect(can(grants, "files", "write", "/a")).toBe(false);
  });
});

const files = (map: Record<string, unknown>) =>
  fileRoleSource(async (path) => {
    const v = map[path];
    return v === undefined ? undefined : JSON.stringify(v);
  });

describe("role sources", () => {
  it("the access file names members and their roles, with custom roles beside it", async () => {
    const source = files({
      "/alpha/.system/access": { ann: "reviewer", bob: ["reader", "editor"] },
      "/alpha/.system/roles": { reviewer: "role:reader, comments.write" },
    });
    expect(await source.members("alpha")).toEqual({ ann: ["reviewer"], bob: ["reader", "editor"] });
    expect(await source.access("alpha", "ann")).toEqual({
      roles: ["reviewer"],
      definitions: { reviewer: "role:reader, comments.write" },
    });
    expect(await source.access("nowhere", "ann")).toBeUndefined();
    const ann = await accessOf(source, "alpha", "ann");
    expect(ann.member).toBe(true);
    expect(can(ann.grants, "comments", "write", "/a")).toBe(true);
    const carol = await accessOf(source, "alpha", "carol");
    expect(carol).toMatchObject({ member: false, grants: [] });
  });

  it("the workspace's own access file names its admins, who are members of no project by it", async () => {
    const source = files({
      "/.system/access": { carol: "admin" },
      "/alpha/.system/access": { ann: "reader" },
    });
    expect(await source.workspaceRoles("carol")).toEqual(["admin"]);
    const carol = await accessOf(source, "alpha", "carol");
    expect(carol.member).toBe(false);
    expect(can(carol.grants, "members", "manage")).toBe(true);
    expect(can(carol.grants, "files", "read", "/a")).toBe(false);
  });

  it("a chain answers each project from the first source that knows it", async () => {
    const first = files({ "/alpha/.system/access": { bob: "owner" } });
    const second = files({
      "/alpha/.system/access": { ann: "owner" },
      "/beta/.system/access": { ann: "reader" },
      "/.system/access": { carol: "admin" },
    });
    const chain: RoleSource = chainRoleSources([first, second]);
    expect((await accessOf(chain, "alpha", "ann")).member).toBe(false);
    expect((await accessOf(chain, "alpha", "bob")).member).toBe(true);
    expect((await accessOf(chain, "beta", "ann")).member).toBe(true);
    expect(await chain.members("alpha")).toEqual({ bob: ["owner"] });
    expect(await chain.workspaceRoles("carol")).toEqual(["admin"]);
  });

  it("a member is a user holding at least one role that resolves", async () => {
    const source = files({ "/alpha/.system/access": { ann: "ghost", bob: [] } });
    expect((await accessOf(source, "alpha", "ann")).member).toBe(false);
    expect((await accessOf(source, "alpha", "bob")).member).toBe(false);
  });
});
