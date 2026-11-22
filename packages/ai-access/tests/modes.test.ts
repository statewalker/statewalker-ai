// Modes and permission rules (statewalker/statewalker-root#124, decided in #79): a mode is a named
// bundle of allow/ask/deny rules with a verdict for actions no rule matches; rules come from the
// deployment, the project, the user, the agent session and the mode; deny beats ask, and ask beats
// allow. The built-in modes follow Claude Code's identifiers. Where no risk classifier runs, `auto`
// asks as `default` does (the classifier is in auto.test.ts).

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  ApprovalRegistry,
  BUILT_IN_MODES,
  decideMode,
  modeOf,
  parseModes,
  toolRequest,
} from "../src/index.js";

/** CPU milliseconds the test's own thread has used: what a Durable Object's CPU limit counts. */
const cpuMs = () => {
  const usage = (process as { threadCpuUsage?: () => NodeJS.CpuUsage }).threadCpuUsage;
  const { user, system } = usage ? usage() : process.cpuUsage();
  return (user + system) / 1000;
};

const files = (action: string, target: string) => ({ area: "files", action, target });
const verdict = (mode: string, req: ReturnType<typeof files>, layers = []) =>
  decideMode(req, { mode: modeOf(mode), layers }).verdict;

describe("modes", () => {
  it("default allows reads and lists and asks about writes and deletes", () => {
    expect(verdict("default", files("read", "/a.md"))).toBe("allow");
    expect(verdict("default", files("list", "/"))).toBe("allow");
    expect(verdict("default", files("write", "/a.md"))).toBe("ask");
    expect(verdict("default", files("delete", "/a.md"))).toBe("ask");
    expect(verdict("default", { area: "db", action: "write", target: "main" })).toBe("ask");
  });

  it("lets memory be written in every mode but plan, which denies it; a rule still decides", () => {
    const memory = (target: string) => ({ area: "memory", action: "write", target });
    // `auto` sends memory writes to its classifier (auto.test.ts); without one it asks.
    expect(verdict("auto", memory("project") as never)).toBe("ask");
    for (const mode of ["default", "acceptEdits", "bypassPermissions", "dontAsk"])
      for (const kind of ["project", "agent", "user", "preferences"])
        expect(verdict(mode, memory(kind) as never)).toBe("allow");
    for (const kind of ["project", "agent", "user", "preferences"])
      expect(verdict("plan", memory(kind) as never)).toBe("deny");
    const layers = [{ source: "project", rules: { deny: ["memory.write:project"] } }];
    expect(verdict("default", memory("project") as never, layers as never)).toBe("deny");
    expect(verdict("default", memory("agent") as never, layers as never)).toBe("allow");
  });

  it("acceptEdits allows file edits but still asks about deletes", () => {
    expect(verdict("acceptEdits", files("write", "/src/a.ts"))).toBe("allow");
    expect(verdict("acceptEdits", files("delete", "/src/a.ts"))).toBe("ask");
  });

  it("plan writes only in its configured folders and asks to widen or switch elsewhere", () => {
    expect(verdict("plan", files("read", "/src/a.ts"))).toBe("allow");
    expect(verdict("plan", files("write", "/plans/p.md"))).toBe("allow");
    expect(verdict("plan", files("write", "/plans"))).toBe("allow");
    expect(verdict("plan", files("write", "/plansx/p.md"))).toBe("ask");
    const elsewhere = decideMode(files("write", "/src/a.ts"), { mode: modeOf("plan"), layers: [] });
    expect(elsewhere.verdict).toBe("ask");
    expect(elsewhere.reason).toMatch(/plan.*\/plans.*widen.*switch/);
    const custom = parseModes({ plan: { extends: "plan", folders: ["/docs/plans"] } });
    expect(custom.problems).toEqual([]);
    const mode = modeOf("plan", custom.modes);
    expect(decideMode(files("write", "/docs/plans/a.md"), { mode, layers: [] }).verdict).toBe(
      "allow",
    );
    expect(decideMode(files("write", "/plans/a.md"), { mode, layers: [] }).verdict).toBe("ask");
  });

  it("bypassPermissions never asks, and a deny rule still denies", () => {
    expect(verdict("bypassPermissions", files("delete", "/a.md"))).toBe("allow");
    const layers = [
      { source: "project", rules: { ask: ["files.write"], deny: ["files.delete:/keep/**"] } },
    ];
    expect(verdict("bypassPermissions", files("write", "/a.md"), layers as never)).toBe("allow");
    expect(verdict("bypassPermissions", files("delete", "/keep/a.md"), layers as never)).toBe(
      "deny",
    );
  });

  it("dontAsk never prompts: allow rules run, everything else is denied", () => {
    expect(verdict("dontAsk", files("read", "/a.md"))).toBe("allow");
    expect(verdict("dontAsk", files("write", "/a.md"))).toBe("deny");
    const layers = [{ source: "user", rules: { allow: ["files.write:/notes/**"] } }];
    expect(verdict("dontAsk", files("write", "/notes/a.md"), layers as never)).toBe("allow");
    const asking = [{ source: "project", rules: { ask: ["files.write:/notes/**"] } }];
    expect(verdict("dontAsk", files("write", "/notes/a.md"), [...layers, ...asking] as never)).toBe(
      "deny",
    );
  });

  it("without the classifier, auto asks as default does", () => {
    for (const req of [files("read", "/a"), files("write", "/a"), files("delete", "/a")])
      expect(verdict("auto", req)).toBe(verdict("default", req));
  });

  it("deny beats ask and ask beats allow, whichever layer holds each", () => {
    const req = files("write", "/src/a.ts");
    const allow = { source: "session", rules: { allow: ["files.write:/src/a.ts"] } };
    const ask = { source: "deployment", rules: { ask: ["files.write:/src/**"] } };
    const deny = { source: "user", rules: { deny: ["files.*:/src/**"] } };
    const at = (...layers: object[]) =>
      decideMode(req, { mode: modeOf("acceptEdits"), layers: layers as never });
    expect(at(allow).verdict).toBe("allow");
    expect(at(allow, ask).verdict).toBe("ask");
    expect(at(ask, allow).verdict).toBe("ask");
    expect(at(allow, ask, deny)).toMatchObject({ verdict: "deny", source: "user" });
    // A session allow rule settles what the mode would ask about.
    expect(decideMode(req, { mode: modeOf("default"), layers: [allow] }).verdict).toBe("allow");
  });

  it("decides the 10,000 entries of a folder's removal against several rule layers well within the CPU limit", () => {
    const rules = (n: number, verb: string) =>
      Array.from({ length: n }, (_, i) => `files.${verb}:/area${i}/**`);
    const layers = [
      { source: "deployment", rules: { deny: rules(20, "delete"), ask: rules(20, "write") } },
      { source: "project", rules: { deny: ["files.delete:/locked/**"], allow: rules(20, "read") } },
      { source: "user", rules: { allow: rules(20, "delete") } },
    ];
    const mode = modeOf("default");
    const started = cpuMs();
    for (let i = 0; i < 10_000; i++)
      decideMode(files("delete", `/build/d${i % 100}/f${i}.js`), { mode, layers });
    // A Durable Object's default CPU limit is 30 s; deciding the entries takes a small part of it.
    expect(cpuMs() - started).toBeLessThan(2_000);
    // Still decided per entry: a deny rule inside the folder applies.
    expect(decideMode(files("delete", "/locked/a.js"), { mode, layers }).verdict).toBe("deny");
  });

  it("decides a tool by its action: read tools where reads are allowed, the rest as changes", () => {
    const read = toolRequest({ id: "w/forecast", name: "w__forecast", action: "read" });
    const write = toolRequest({ id: "w/report", name: "w__report", action: "write" });
    const admin = toolRequest({ id: "w/purge", name: "w__purge", action: "admin" });
    for (const mode of ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"])
      expect(verdict(mode, read as never)).toBe("allow");
    expect(verdict("default", write as never)).toBe("ask");
    expect(verdict("acceptEdits", admin as never)).toBe("ask");
    expect(verdict("plan", write as never)).toBe("ask");
    expect(verdict("dontAsk", write as never)).toBe("deny");
    expect(verdict("bypassPermissions", admin as never)).toBe("allow");
    // A tool rule names the tool as the model sees it.
    const deny = { source: "user", rules: { deny: ["tool:w__forecast"] } };
    expect(verdict("default", read as never, [deny] as never)).toBe("deny");
  });

  it("matches tool rules by tool name", () => {
    const layers = [{ source: "project", rules: { deny: ["tool:bash"], allow: ["tool:grep"] } }];
    const call = (tool: string) => ({ area: "tools", action: "call", target: tool, tool });
    expect(decideMode(call("bash"), { mode: modeOf("bypassPermissions"), layers }).verdict).toBe(
      "deny",
    );
    expect(decideMode(call("grep"), { mode: modeOf("default"), layers }).verdict).toBe("allow");
    expect(decideMode(call("other"), { mode: modeOf("default"), layers }).verdict).toBe("ask");
  });

  it("ignores an unknown mode name and malformed rules instead of widening", () => {
    expect(() => modeOf("yolo")).toThrow(/EINVAL/);
    const parsed = parseModes({ odd: { rules: { allow: ["frobs.read", "files.read"] } } });
    expect(parsed.problems.join()).toMatch(/frobs/);
    // A custom mode with no verdict for unmatched actions asks.
    expect(
      decideMode(files("write", "/a"), { mode: modeOf("odd", parsed.modes), layers: [] }).verdict,
    ).toBe("ask");
    expect(Object.keys(BUILT_IN_MODES).sort()).toEqual(
      ["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"].sort(),
    );
  });
});

describe("the approval registry", () => {
  // The Workspace DO's SQLite, stood in for by Node's: only what the registry asks of it.
  const sqlOf = () => {
    const db = new DatabaseSync(":memory:");
    return {
      exec(query: string, ...bindings: unknown[]) {
        const statement = db.prepare(query);
        const rows = statement.columns().length
          ? statement.all(...(bindings as never[]))
          : statement.run(...(bindings as never[])) && [];
        return { toArray: () => rows as Record<string, unknown>[] };
      },
    };
  };

  it("an approval for the session covers only its own target, never a folder's subtree or a pattern a file name spells", () => {
    const registry = new ApprovalRegistry(sqlOf());
    const expires = Date.now() + 60_000;
    for (const [id, permission] of [
      ["ap-1", "files.write:/notes/*.md"],
      ["ap-2", "files.write:/src"],
    ] as const)
      registry.grant("ann", { id, session: "as-1", scope: "session", permission, expires });
    const layer = registry.sessionLayer("as-1", "ann");
    const at = (target: string) =>
      decideMode(
        { area: "files", action: "write", target },
        { mode: modeOf("default"), layers: [layer] },
      ).verdict;
    expect(at("/src")).toBe("allow");
    expect(at("/notes/*.md")).toBe("allow");
    expect(at("/src/run.sh")).toBe("ask");
    expect(at("/notes/a.md")).toBe("ask");
    expect(
      decideMode(
        { area: "files", action: "write", target: "/src" },
        { mode: modeOf("default"), layers: [registry.sessionLayer("as-1", "bob")] },
      ).verdict,
    ).toBe("ask");
    expect(registry.consume("ap-1", "as-1", "ann")).toBe(true);
    expect(registry.consume("ap-1", "as-1", "ann")).toBe(false);
    expect(registry.consume("ap-2", "as-2", "ann")).toBe(false);
  });

  it("an expired grant of an approval is never used, however recently it expired", () => {
    const registry = new ApprovalRegistry(sqlOf());
    const now = Date.now();
    const grant = (id: string, expires: number) =>
      registry.grant("ann", {
        id,
        session: "as-1",
        scope: "once",
        permission: "files.write:/a",
        expires,
      });
    grant("ap-1", now - 1);
    grant("ap-2", now);
    grant("ap-3", now + 60_000);
    expect(registry.consume("ap-1", "as-1", "ann", now)).toBe(false);
    expect(registry.consume("ap-2", "as-1", "ann", now)).toBe(false);
    // An unexpired grant stops working the moment it expires.
    expect(registry.consume("ap-3", "as-1", "ann", now + 60_000)).toBe(false);
    grant("ap-3", now + 60_000);
    expect(registry.consume("ap-3", "as-1", "ann", now + 59_999)).toBe(true);
  });
});
