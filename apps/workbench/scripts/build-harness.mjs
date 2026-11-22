// Builds the harness for this page: ai-host-do bundled for browsers by `cellb build` into
// public/harness/, its configuration made a browser deployment's (no deployment-held secret:
// @statewalker/ai-host-do/browser) with the development login on, since the page is its user's own.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(app, "public", "harness");
execFileSync(
  join(app, "node_modules", ".bin", "cellb"),
  ["build", join(app, "..", "..", "packages", "ai-host-do"), "--out", out],
  { stdio: "inherit" },
);

const { browserDeploymentVars } = await import(
  join(app, "..", "..", "packages", "ai-host-do", "src", "browser.ts")
);
const file = join(out, "wrangler.json");
const config = JSON.parse(readFileSync(file, "utf8"));
config.vars = browserDeploymentVars({ ...config.vars, DEV_LOGIN: "true" });
writeFileSync(file, JSON.stringify(config, null, 2));
console.log(`harness: ${out} (a browser deployment)`);
