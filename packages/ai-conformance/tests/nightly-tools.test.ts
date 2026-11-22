// The nightly runs' own tools (statewalker/statewalker-root#145): each failing job files an issue
// in the project's tracker (one open issue per job, later failures as comments), the mutation run
// requires every mutant to be killed, and the Flue job moves the catalog to Flue's latest release.
import { describe, expect, it } from "vitest";
import { withCatalogVersion } from "../src/nightly/flue-latest.js";
import { type Mutation, mutate } from "../src/nightly/mutate.js";
import { type GitHub, reportNightly } from "../src/nightly/report.js";

/** An issue tracker in memory, answering the REST calls the reporter makes. */
function tracker(existing: { number: number; title: string; labels: string[] }[] = []) {
  const issues = existing.map((i) => ({ ...i, comments: [] as string[], body: "" }));
  const labels: string[] = [];
  const github: GitHub = async (method, route, body) => {
    const b = body as Record<string, unknown> | undefined;
    if (method === "GET" && route.startsWith("/issues?")) {
      const label = new URLSearchParams(route.split("?")[1]).get("labels");
      return issues
        .filter((i) => !label || i.labels.includes(label))
        .map((i) => ({ number: i.number, title: i.title, html_url: `#${i.number}` }));
    }
    if (method === "POST" && route === "/labels") {
      labels.push(String(b?.name));
      return {};
    }
    if (method === "POST" && route === "/issues") {
      const issue = {
        number: 100 + issues.length,
        title: String(b?.title),
        labels: b?.labels as string[],
        body: String(b?.body),
        comments: [] as string[],
      };
      issues.push(issue);
      return { number: issue.number, html_url: `#${issue.number}` };
    }
    const comment = /^\/issues\/(\d+)\/comments$/.exec(route);
    if (method === "POST" && comment) {
      issues.find((i) => i.number === Number(comment[1]))?.comments.push(String(b?.body));
      return {};
    }
    throw new Error(`unexpected ${method} ${route}`);
  };
  return { github, issues, labels };
}

describe("nightly reports", () => {
  const run = "https://github.com/statewalker/statewalker-ai/actions/runs/1";

  it("files one issue per failing job, naming the job, the run and the details", async () => {
    const t = tracker();
    await reportNightly(t.github, {
      job: "mutation",
      outcome: "failure",
      runUrl: run,
      details: "2 mutants survived",
    });
    await reportNightly(t.github, { job: "flue-latest", outcome: "failure", runUrl: run });
    expect(t.issues.map((i) => i.title)).toEqual([
      "Nightly: mutation fails",
      "Nightly: flue-latest fails",
    ]);
    expect(t.issues[0]?.labels).toEqual(["bug", "ci-baseline"]);
    expect(t.issues[0]?.body).toContain(run);
    expect(t.issues[0]?.body).toContain("2 mutants survived");
    expect(new Set(t.labels)).toEqual(new Set(["bug", "ci-baseline"]));
  });

  it("comments on the job's open issue instead of filing another", async () => {
    const t = tracker([
      { number: 7, title: "Nightly: scale fails", labels: ["bug", "ci-baseline"] },
    ]);
    await reportNightly(t.github, {
      job: "scale",
      outcome: "failure",
      runUrl: run,
      details: "oom",
    });
    expect(t.issues).toHaveLength(1);
    expect(t.issues[0]?.comments).toEqual([expect.stringContaining(run)]);
    expect(t.issues[0]?.comments[0]).toContain("oom");
  });

  it("writes nothing for a passing, skipped or cancelled job", async () => {
    const t = tracker();
    for (const outcome of ["success", "skipped", "cancelled"] as const)
      await reportNightly(t.github, { job: "scale", outcome, runUrl: run });
    expect(t.issues).toEqual([]);
  });
});

describe("mutation runs", () => {
  const files = () =>
    new Map([
      ["a.ts", "export const allow = (x: number) => x > 0;\n"],
      ["b.ts", "export const deny = true;\n"],
    ]);
  const io = (fs: Map<string, string>) => ({
    read: async (f: string) => fs.get(f) as string,
    write: async (f: string, s: string) => void fs.set(f, s),
  });

  it("reports the mutants no suite kills, and restores every file", async () => {
    const fs = files();
    const mutations: Mutation[] = [
      { id: "lenient", file: "a.ts", find: "x > 0", replace: "x >= 0", suites: ["unit"] },
      { id: "flip", file: "b.ts", find: "= true", replace: "= false", suites: ["unit", "e2e"] },
    ];
    // "unit" catches only the lenient comparison; "e2e" catches nothing.
    const result = await mutate(mutations, {
      ...io(fs),
      run: async (suite) => !(suite === "unit" && fs.get("a.ts")?.includes(">=")),
    });
    expect(result.killed.map((m) => m.id)).toEqual(["lenient"]);
    expect(result.survived.map((m) => m.id)).toEqual(["flip"]);
    expect(fs).toEqual(files());
  });

  it("counts a mutant whose excerpt is not in the source exactly once as an error, not a kill", async () => {
    const fs = files();
    const result = await mutate(
      [
        { id: "gone", file: "a.ts", find: "x < 0", replace: "x", suites: ["unit"] },
        { id: "twice", file: "a.ts", find: "x", replace: "y", suites: ["unit"] },
      ],
      { ...io(fs), run: async () => true },
    );
    expect(result.killed).toEqual([]);
    expect(result.survived).toEqual([]);
    expect(result.errors.map((e) => e.id)).toEqual(["gone", "twice"]);
    expect(fs).toEqual(files());
  });

  it("requires the unmutated source to pass every suite first", async () => {
    const fs = files();
    await expect(
      mutate([{ id: "m", file: "a.ts", find: "x > 0", replace: "x >= 0", suites: ["unit"] }], {
        ...io(fs),
        run: async () => false,
      }),
    ).rejects.toThrow(/unmutated.*unit/);
  });
});

describe("following Flue", () => {
  const yaml = [
    "catalog:",
    '  "@earendil-works/pi-ai": ~1.4.0',
    '  "@flue/runtime": ~2.3.0',
    "  tsx: ^4.23.15",
    "",
    "overrides:",
    '  "@flue/runtime": ~2.3.0',
    "",
  ].join("\n");

  it("moves the catalog entry to the given release, and nothing else", () => {
    expect(withCatalogVersion(yaml, "@flue/runtime", "2.9.1")).toBe(
      yaml.replace('  "@flue/runtime": ~2.3.0\n  tsx', '  "@flue/runtime": 2.9.1\n  tsx'),
    );
  });

  it("refuses a catalog without the entry", () => {
    expect(() => withCatalogVersion(yaml, "@flue/other", "1.0.0")).toThrow(/@flue\/other/);
  });
});
