// A browser deployment: the harness on CellB in one person's page (statewalker/statewalker-root#132).
// Everything a page loads can be read by whoever holds the page, so a browser deployment holds no
// key of the deployment's: SECRETS_KEY and DEPLOYMENT_SECRETS, and the variables the latter names,
// are kept off it, and only its users' own secrets are kept, sealed with a key the page makes for
// itself (`localSecretsKey`). The Workspace DO refuses the other levels when HOSTING is "browser".

/** The variables a deployment-held secret lives in, which never reach a browser deployment. */
function heldSecretNames(vars: Record<string, string>): string[] {
  // ADMIN_KEY opens the test-only admin routes: a server's never reaches a page.
  const names = ["SECRETS_KEY", "DEPLOYMENT_SECRETS", "ADMIN_KEY"];
  try {
    const declared = JSON.parse(vars.DEPLOYMENT_SECRETS ?? "{}");
    if (declared && typeof declared === "object") names.push(...Object.keys(declared));
  } catch {
    // Unreadable: nothing more is named; DEPLOYMENT_SECRETS itself is dropped all the same.
  }
  return names;
}

export interface BrowserDeploymentOptions {
  /**
   * Held names the caller keeps on purpose: only "ADMIN_KEY", for a key the page made for itself
   * (the conformance runner's, the workbench's). SECRETS_KEY and DEPLOYMENT_SECRETS are never kept.
   */
  keep?: readonly "ADMIN_KEY"[];
}

/**
 * `vars` as a browser deployment gets them: without deployment-held secrets (and without a
 * server's ADMIN_KEY), HOSTING "browser".
 */
export function browserDeploymentVars(
  vars: Record<string, string>,
  options: BrowserDeploymentOptions = {},
): Record<string, string> {
  const out = { ...vars };
  const keep = new Set<string>(options.keep ?? []);
  keep.delete("SECRETS_KEY");
  keep.delete("DEPLOYMENT_SECRETS");
  for (const name of heldSecretNames(vars)) if (!keep.has(name)) delete out[name];
  out.HOSTING = "browser";
  return out;
}

/** A Worker configuration (wrangler.json) with `vars` over its own, as a browser deployment's. */
export function browserDeploymentConfig<C extends { vars?: Record<string, string> }>(
  config: C,
  vars: Record<string, string> = {},
  options: BrowserDeploymentOptions = {},
): C {
  return { ...config, vars: browserDeploymentVars({ ...config.vars, ...vars }, options) };
}

/** Whether the deployment runs in a browser page (HOSTING "browser"). */
export const isBrowserHosting = (env: { HOSTING?: string }) => env.HOSTING === "browser";

interface Sql {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

/**
 * The key a browser deployment's Workspace DO seals its users' secrets with: made once, from the
 * page's own randomness, and kept in that DO's storage (the page's own OPFS), never configured.
 */
export function localSecretsKey(sql: Sql): string {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS secrets_local_key (id INTEGER PRIMARY KEY, key TEXT NOT NULL)",
  );
  const row = sql.exec("SELECT key FROM secrets_local_key WHERE id = 1").toArray()[0];
  if (row) return String(row.key);
  const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  sql.exec("INSERT INTO secrets_local_key (id, key) VALUES (1, ?)", key);
  return key;
}
