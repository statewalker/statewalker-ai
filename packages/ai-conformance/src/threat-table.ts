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
    // A row with one cell is still a row: it names no test, and the check reports it.
    if (!cells) continue;
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

/**
 * `it(...)` / `test(...)`, also `.only`, `.concurrent`, `.sequential` and `.each([...])` forms.
 * Not `describe` (a group title proves nothing), nor `.skip` / `.todo` (they don't run).
 */
const TEST_CALL =
  /\b(?:it|test)(?:\.(?:only|concurrent|sequential))*(?:\.each\([^)]*\))?\(\s*(["'`])((?:(?!\1).)+)\1/g;

/** The source with `//` and block comments blanked, leaving strings alone. */
function withoutComments(source: string): string {
  let out = "";
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '"' || c === "'" || c === "`") {
      const start = i;
      for (i++; i < source.length && source[i] !== c; i++) if (source[i] === "\\") i++;
      out += source.slice(start, i + 1);
    } else if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && source[i + 1] === "*") {
      i = source.indexOf("*/", i + 2) + 1;
      if (i === 0) break;
    } else out += c;
  }
  return out;
}

/** The titles of every running `it` / `test` in the test files under a folder. */
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
        for (const m of withoutComments(readFileSync(u, "utf8")).matchAll(TEST_CALL))
          titles.push(String(m[2]));
    }
  };
  walk(dir);
  return titles;
}
