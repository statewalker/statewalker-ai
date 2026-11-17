// The threat table (docs/security.md): a Markdown table of security properties, each row naming
// the tests that prove it as `<package>`: "<test title>" pairs separated by ";".
import { readdirSync, readFileSync, statSync } from "node:fs";

export interface ThreatRow {
  property: string;
  tests: { pkg: string; title: string }[];
}

const REF = /`([^`]+)`:\s*"([^"]+)"/g;

export function parseThreatTable(markdown: string): ThreatRow[] {
  const rows: ThreatRow[] = [];
  for (const line of markdown.split("\n")) {
    const cells = line
      .trim()
      .match(/^\|(.*)\|$/)?.[1]
      ?.split("|")
      .map((c) => c.trim());
    if (!cells || cells.length < 2) continue;
    const [property = "", tests = ""] = cells;
    if (/^-+$/.test(property.replace(/:/g, "")) || property === "Property") continue;
    rows.push({
      property,
      tests: [...tests.matchAll(REF)].map((m) => ({ pkg: String(m[1]), title: String(m[2]) })),
    });
  }
  return rows;
}

/** Problems with the table: rows naming no test, or naming a test that does not exist. */
export function checkThreatTable(markdown: string, titlesOf: (pkg: string) => string[]): string[] {
  const problems: string[] = [];
  for (const row of parseThreatTable(markdown)) {
    if (row.tests.length === 0) problems.push(`'${row.property}' names no test`);
    for (const t of row.tests)
      if (!titlesOf(t.pkg).includes(t.title))
        problems.push(`'${row.property}': no test "${t.title}" in ${t.pkg}`);
  }
  return problems;
}

/** The titles of every `it`/`test`/`describe` in the test files under a folder. */
export function collectTestTitles(dir: URL): string[] {
  const titles: string[] = [];
  const walk = (d: URL) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names) {
      const u = new URL(name, d);
      if (statSync(u).isDirectory()) walk(new URL(`${name}/`, d));
      else if (/\.test\.(ts|mts|js|mjs)$/.test(name))
        for (const m of readFileSync(u, "utf8").matchAll(
          /\b(?:it|test|describe)\(\s*(["'`])((?:(?!\1).)+)\1/g,
        ))
          titles.push(String(m[2]));
    }
  };
  walk(dir);
  return titles;
}
