// The threat table (docs/security.md): every row names the tests that prove it, and they exist.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { checkThreatTable, collectTestTitles, parseThreatTable } from "../src/index.js";

const repo = new URL("../../../", import.meta.url);

describe("threat table", () => {
  it("parses rows into a property and the tests named for it", () => {
    const rows = parseThreatTable(
      [
        "| Property | Tests |",
        "|---|---|",
        '| System folder hidden | `ai-environment`: "hides the system folder"; `ai-conformance`: "refuses .system" |',
      ].join("\n"),
    );
    expect(rows).toEqual([
      {
        property: "System folder hidden",
        tests: [
          { pkg: "ai-environment", title: "hides the system folder" },
          { pkg: "ai-conformance", title: "refuses .system" },
        ],
      },
    ]);
  });

  it("fails a row that names no test", () => {
    const problems = checkThreatTable("| Property | Tests |\n|---|---|\n| Isolation | |", () => []);
    expect(problems).toEqual(["'Isolation' names no test"]);
  });

  it("fails a row whose test does not exist", () => {
    const problems = checkThreatTable(
      '| Property | Tests |\n|---|---|\n| Isolation | `ai-access`: "isolates workspaces" |',
      () => ["something else"],
    );
    expect(problems).toEqual([`'Isolation': no test "isolates workspaces" in ai-access`]);
  });

  it("fails a row with a single cell, which names no test", () => {
    expect(checkThreatTable("| Property | Tests |\n|---|---|\n| Lonely |", () => [])).toEqual([
      "'Lonely' names no test",
    ]);
  });

  it("counts only it/test titles, not describe groups or commented-out tests", () => {
    const dir = mkdtempSync(join(tmpdir(), "threat-table-"));
    try {
      writeFileSync(
        join(dir, "a.test.ts"),
        [
          'describe("a group", () => {',
          '  it("a real test", () => {});',
          '  test.each([1])("an each test %s", () => {});',
          '  it.skipIf(RUNTIME === "browser")("a test some runtime skips", () => {});',
          '  // it("a commented test", () => {});',
          '  /* test("a block-commented test", () => {}); */',
          "});",
        ].join("\n"),
      );
      expect(collectTestTitles(pathToFileURL(`${dir}/`))).toEqual([
        "a real test",
        "an each test %s",
        "a test some runtime skips",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("holds for this repository's docs/security.md", () => {
    const md = readFileSync(new URL("docs/security.md", repo), "utf8");
    const titles = (pkg: string) => collectTestTitles(new URL(`packages/${pkg}/tests/`, repo));
    expect(checkThreatTable(md, titles)).toEqual([]);
  });
});
