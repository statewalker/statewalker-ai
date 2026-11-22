// The nightly mutation run (statewalker/statewalker-root#145, decided in #85), shaped like
// webrun-biscuit's `mutate` script: a list of known defects, each a literal excerpt of the source
// and its replacement, and the suites that must catch it. Each mutant is applied alone, the suites
// run in order until one fails (the mutant is killed), and the file is restored. A surviving mutant
// is a hole in the tests, not a success: the run fails and the nightly job files an issue.
//
// An excerpt must match exactly once, so a refactor of the source makes the run fail loudly (an
// error) rather than quietly stop testing anything. The unmutated source must pass every suite
// first, or no kill would mean anything.
//
//   node mutate.ts <mutations.json> [--report <path>]
//
// mutations.json: `{ "suites": {"<name>": "<shell command>"}, "mutations": [Mutation...] }`, paths
// relative to the current directory. One file with no imports but node's, so node runs it straight
// from the source.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export interface Mutation {
  id: string;
  /** What the defect would let through. */
  why?: string;
  file: string;
  /** A literal excerpt of the file, present exactly once. */
  find: string;
  replace: string;
  /** The suites that must catch it, cheapest first. */
  suites: string[];
}

export interface MutationIo {
  read(file: string): Promise<string>;
  write(file: string, content: string): Promise<void>;
  /** Runs a suite; true when it passes. */
  run(suite: string): Promise<boolean>;
}

export interface MutationResult {
  killed: (Mutation & { by: string })[];
  survived: Mutation[];
  errors: (Mutation & { error: string })[];
}

const occurrences = (text: string, part: string) => text.split(part).length - 1;

export async function mutate(mutations: Mutation[], io: MutationIo): Promise<MutationResult> {
  for (const suite of new Set(mutations.flatMap((m) => m.suites)))
    if (!(await io.run(suite))) throw new Error(`the unmutated source fails the suite '${suite}'`);
  const result: MutationResult = { killed: [], survived: [], errors: [] };
  for (const m of mutations) {
    const source = await io.read(m.file);
    const n = occurrences(source, m.find);
    if (n !== 1) {
      result.errors.push({ ...m, error: `the excerpt is in ${m.file} ${n} times, not once` });
      continue;
    }
    await io.write(
      m.file,
      source.replace(m.find, () => m.replace),
    );
    try {
      let by: string | undefined;
      for (const suite of m.suites)
        if (!(await io.run(suite))) {
          by = suite;
          break;
        }
      if (by) result.killed.push({ ...m, by });
      else result.survived.push(m);
    } finally {
      await io.write(m.file, source);
    }
  }
  return result;
}

/** The run as Markdown, for the nightly issue. */
export function mutationReport(result: MutationResult): string {
  const total = result.killed.length + result.survived.length + result.errors.length;
  const lines = [`${result.killed.length} of ${total} mutants killed.`];
  const row = (m: Mutation, extra = "") =>
    `- \`${m.id}\` in \`${m.file}\`: \`${m.find}\` → \`${m.replace}\`${m.why ? ` (${m.why})` : ""}${extra}`;
  if (result.survived.length)
    lines.push(
      "",
      "Survived (no suite caught them):",
      ...result.survived.map((m) => row(m, `, suites ${m.suites.join(", ")}`)),
    );
  if (result.errors.length)
    lines.push(
      "",
      "Not applied (fix the excerpt):",
      ...result.errors.map((m) => row(m, `: ${m.error}`)),
    );
  return lines.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { report: { type: "string" } },
  });
  const config = JSON.parse(readFileSync(String(positionals[0]), "utf8")) as {
    suites: Record<string, string>;
    mutations: Mutation[];
  };
  const result = await mutate(config.mutations, {
    read: (f) => readFile(f, "utf8"),
    write: (f, s) => writeFile(f, s),
    run: async (suite) => {
      const command = config.suites[suite];
      if (!command) throw new Error(`no suite '${suite}'`);
      try {
        execSync(command, { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    },
  });
  for (const m of result.killed) console.log(`killed    ${m.id} (by ${m.by})`);
  for (const m of result.survived) console.log(`SURVIVED  ${m.id}`);
  for (const m of result.errors) console.log(`ERROR     ${m.id}: ${m.error}`);
  const report = mutationReport(result);
  console.log(`\n${report}`);
  if (values.report) writeFileSync(values.report, report);
  process.exit(result.survived.length || result.errors.length ? 1 : 0);
}
