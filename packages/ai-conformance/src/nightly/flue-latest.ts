// Moves the workspace catalog's @flue/runtime to Flue's latest release, for the nightly job that
// runs the conformance suite against it (statewalker/statewalker-root#145, decided in #85). Flue
// and pi stay pinned in the repository; upgrades land as ordinary pull requests.
//
//   node flue-latest.ts [pnpm-workspace.yaml]   then: pnpm install --no-frozen-lockfile
//
// One file with no imports but node's, so node runs it straight from the source.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The workspace file with the catalog's `name` at exactly `version`; nothing else changes. */
export function withCatalogVersion(yaml: string, name: string, version: string): string {
  const lines = yaml.split("\n");
  let inCatalog = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (/^\S/.test(line)) inCatalog = line.trim() === "catalog:";
    else if (inCatalog) {
      const m = /^(\s+)("?)([^":\s]+)\2:\s*(\S+)(.*)$/.exec(line);
      if (m && m[3] === name) {
        lines[i] = `${m[1]}${m[2]}${name}${m[2]}: ${version}${m[5]}`;
        return lines.join("\n");
      }
    }
  }
  throw new Error(`the catalog has no ${name}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2] ?? "pnpm-workspace.yaml";
  const version = execFileSync("npm", ["view", "@flue/runtime", "version"], {
    encoding: "utf8",
  }).trim();
  writeFileSync(file, withCatalogVersion(readFileSync(file, "utf8"), "@flue/runtime", version));
  console.log(`@flue/runtime → ${version} (Flue's latest release)`);
}
