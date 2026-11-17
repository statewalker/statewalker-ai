// The threat table (docs/security.md): every row names the tests that prove it, and they exist.
import { readFileSync } from "node:fs";
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

  it("holds for this repository's docs/security.md", () => {
    const md = readFileSync(new URL("docs/security.md", repo), "utf8");
    const titles = (pkg: string) => collectTestTitles(new URL(`packages/${pkg}/tests/`, repo));
    expect(checkThreatTable(md, titles)).toEqual([]);
  });
});
