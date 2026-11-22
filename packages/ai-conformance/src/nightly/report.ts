// Reports a nightly job to the project's own issue tracker (statewalker/statewalker-root#145), as
// statewalker/statewalker-ci's report-nightly.mjs does for one suite, but one issue per job:
//   - failure: one open `bug` issue labelled `ci-baseline`, titled "Nightly: <job> fails", with the
//     run and the job's details; while it is open, a later failure comments on it instead;
//   - success, skipped or cancelled: nothing is written.
//
//   node report.ts --job <name> --outcome <outcome> --run-url <url> [--details-file <path>]
//
// GitHub Actions provides GITHUB_REPOSITORY and GITHUB_API_URL; GITHUB_TOKEN needs `issues: write`.
// One file with no imports but node's, so node runs it straight from the source.
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** One REST call to the repository (`route` below /repos/<owner>/<repo>); the parsed body. */
export type GitHub = (method: string, route: string, body?: unknown) => Promise<unknown>;

export interface NightlyOutcome {
  job: string;
  outcome: "success" | "failure" | "cancelled" | "skipped";
  runUrl: string;
  /** What failed, in Markdown (a mutation run's surviving mutants, a test summary). */
  details?: string;
}

const LABELS = [
  { name: "bug", color: "d73a4a", description: "Something isn't working" },
  { name: "ci-baseline", color: "ededed", description: "A missing or failing CI baseline measure" },
];

export const issueTitle = (job: string) => `Nightly: ${job} fails`;

/** Files or updates the job's issue on failure; answers its URL, or undefined when nothing was written. */
export async function reportNightly(
  github: GitHub,
  o: NightlyOutcome,
): Promise<string | undefined> {
  if (o.outcome !== "failure") return undefined;
  const title = issueTitle(o.job);
  const when = new Date().toISOString().slice(0, 10);
  const details = o.details?.trim() ? `\n\n${o.details.trim()}` : "";
  const open = (await github("GET", "/issues?state=open&labels=ci-baseline&per_page=100")) as {
    number: number;
    title: string;
    html_url: string;
    pull_request?: unknown;
  }[];
  const existing = open.find((i) => i.title === title && !i.pull_request);
  if (existing) {
    await github("POST", `/issues/${existing.number}/comments`, {
      body: `Failed again on ${when}: ${o.runUrl}${details}`,
    });
    return existing.html_url;
  }
  for (const label of LABELS) await github("POST", "/labels", label);
  const issue = (await github("POST", "/issues", {
    title,
    labels: LABELS.map((l) => l.name),
    body: [
      `The nightly job \`${o.job}\` failed on ${when}.`,
      "",
      `Run: ${o.runUrl}${details}`,
      "",
      "Later failures are added here as comments while this issue is open. Fix the job (or the code",
      "it caught), then close this issue; the next failure opens a new one.",
    ].join("\n"),
  })) as { html_url: string };
  return issue.html_url;
}

/** GitHub's REST API for the repository Actions runs in. A 422 on a label means it exists. */
function restGitHub(repo: string, token: string, api: string): GitHub {
  return async (method, route, body) => {
    const res = await fetch(`${api.replace(/\/$/, "")}/repos/${repo}${route}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    if (!res.ok && !(route === "/labels" && res.status === 422))
      throw new Error(`${method} ${route}: HTTP ${res.status} ${data.message ?? ""}`.trim());
    return data;
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      job: { type: "string" },
      outcome: { type: "string" },
      "run-url": { type: "string" },
      "details-file": { type: "string" },
    },
  });
  const outcome = values.outcome as NightlyOutcome["outcome"];
  if (
    !values.job ||
    !values["run-url"] ||
    !["success", "failure", "cancelled", "skipped"].includes(outcome)
  ) {
    console.error(
      "usage: report.ts --job <name> --outcome <outcome> --run-url <url> [--details-file <path>]",
    );
    process.exit(2);
  }
  const file = values["details-file"];
  const details = file && existsSync(file) ? readFileSync(file, "utf8") : undefined;
  const { GITHUB_REPOSITORY: repo, GITHUB_TOKEN: token, GITHUB_API_URL: api } = process.env;
  if (outcome === "failure" && (!repo || !token)) {
    console.error("nightly: GITHUB_REPOSITORY and GITHUB_TOKEN are required");
    process.exit(2);
  }
  const url = await reportNightly(
    restGitHub(String(repo), String(token), api || "https://api.github.com"),
    {
      job: values.job,
      outcome,
      runUrl: values["run-url"],
      details,
    },
  );
  console.log(
    url
      ? `nightly: ${values.job} failed, reported at ${url}`
      : `nightly: ${values.job} ${outcome}, nothing to report`,
  );
}
