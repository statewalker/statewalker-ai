// Databases' names, declarations and actions (statewalker/statewalker-root#136).
import { describe, expect, it } from "vitest";
import {
  decodeDatabaseAction,
  encodeDatabaseAction,
  formatDatabases,
  isDatabaseName,
  isReadStatement,
  parseDatabases,
  privateDatabaseOf,
} from "../src/index.js";

describe("databases", () => {
  it("names a project's databases with one lowercase word, and a plugin's as <plugin>:<name>", () => {
    for (const name of ["notes", "index-2", "a_b"]) expect(isDatabaseName(name)).toBe(true);
    for (const name of ["", "Notes", "../notes", "a/b", "search:index", ".x", "a".repeat(65)])
      expect(isDatabaseName(name)).toBe(false);
    expect(privateDatabaseOf("search:index")).toEqual({ plugin: "search", name: "index" });
    for (const name of ["notes", "search:", ":index", "a/b:c", "search:Index", "s:i:x"])
      expect(privateDatabaseOf(name)).toBeUndefined();
  });

  it("reads declarations leniently, declaring nothing for what is not a database name", () => {
    expect(parseDatabases(undefined)).toEqual({ databases: {}, problems: [] });
    expect(parseDatabases("not json").problems).toHaveLength(1);
    expect(parseDatabases("[]").problems).toHaveLength(1);
    const { databases, problems } = parseDatabases(
      JSON.stringify({ notes: {}, "../x": {}, idx: { created: 5, by: "ann", other: 1 } }),
    );
    expect(databases).toEqual({ notes: {}, idx: { created: 5, by: "ann" } });
    expect(problems).toEqual(["'../x' is not a database name"]);
    expect(parseDatabases(formatDatabases(databases)).databases).toEqual(databases);
  });

  it("takes for a read only statements that start as one", () => {
    for (const sql of [
      "SELECT 1",
      "  -- why\n  /* c */ (select * from t)",
      "VALUES (1)",
      "WITH a AS (SELECT 1) SELECT * FROM a",
      "explain select 1",
    ])
      expect(isReadStatement(sql)).toBe(true);
    for (const sql of [
      "INSERT INTO t VALUES (1)",
      "WITH a AS (SELECT 1) DELETE FROM t",
      "CREATE TABLE t (x)",
      "PRAGMA table_info(t)",
      "",
      "/* unterminated",
    ])
      expect(isReadStatement(sql)).toBe(false);
  });

  it("encodes an action exactly, BLOBs and big integers included", () => {
    const action = {
      op: "query" as const,
      sql: "SELECT ?, ?, ?",
      params: [new Uint8Array([1, 2]), 2n ** 60n, "x"],
    };
    const bytes = encodeDatabaseAction(action);
    expect(encodeDatabaseAction(action)).toEqual(bytes);
    expect(decodeDatabaseAction(bytes)).toEqual(action);
    expect(() => decodeDatabaseAction(new TextEncoder().encode('{"op":"nuke"}'))).toThrow(/EINVAL/);
  });
});
