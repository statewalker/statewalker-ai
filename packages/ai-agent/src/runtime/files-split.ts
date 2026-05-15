import { type FilesApi, normalizePath } from "@statewalker/webrun-files";
import {
  CompositeFilesApi,
  FilteredFilesApi,
  type PathFilter,
} from "@statewalker/webrun-files-composite";

/**
 * Build a path filter that hides everything **at or under** `prefix`.
 * Boundary-aware: `/private` does not hide `/privacy`. Equivalent to
 * `newPathFilter(prefix)` from `@statewalker/webrun-files-composite` but
 * exposed as a function we can compose with subtree-restriction filters.
 */
export function hideUnder(prefix: string): PathFilter {
  const normalized = normalizePath(prefix);
  if (normalized === "/") {
    // Hiding "/" would hide everything — treat as a no-op.
    return () => true;
  }
  const withSlash = `${normalized}/`;
  return (path: string) => {
    const target = normalizePath(path);
    if (target === normalized) return false;
    if (target.startsWith(withSlash)) return false;
    return true;
  };
}

/**
 * Build a path filter that allows only paths inside (or equal to) `prefix`.
 * `prefix === "/"` is the identity filter.
 */
export function insideSubtree(prefix: string): PathFilter {
  const normalized = normalizePath(prefix);
  if (normalized === "/") return () => true;
  const withSlash = `${normalized}/`;
  return (path: string) => {
    const target = normalizePath(path);
    return target === normalized || target.startsWith(withSlash);
  };
}

/**
 * AND-combine two filters. Result is `true` only if both inputs pass.
 * Async filters are awaited; if either rejects the path, the path is hidden.
 */
export function combineFilters(...filters: PathFilter[]): PathFilter {
  return async (path: string) => {
    for (const f of filters) {
      if ((await f(path)) === false) return false;
    }
    return true;
  };
}

/**
 * Build the tools-visible {@link FilesApi} view: a {@link FilteredFilesApi}
 * over `rootFiles` that hides the system path-tree and (optionally)
 * restricts visibility to a user subtree.
 *
 * @deprecated The tools view is now constructed inline in
 *   {@link buildFilesSplit}: when `userPath === "/"`, a `FilteredFilesApi`
 *   hides system paths from the root; otherwise a `CompositeFilesApi`
 *   rebases at `userPath`. This helper is no longer used internally.
 */
export function buildToolsView(
  rootFiles: FilesApi,
  systemPath: string,
  userPath: string,
): FilesApi {
  const filters: PathFilter[] = [hideUnder(systemPath)];
  if (normalizePath(userPath) !== "/") {
    filters.push(insideSubtree(userPath));
  }
  return new FilteredFilesApi(rootFiles, combineFilters(...filters));
}

// ── Path-geometry helpers (relocated from agent-runtime.ts) ──────────────

/** Normalise a folder path: ensure leading slash, strip trailing slash. */
export function normalizeFolderPath(path: string): string {
  let p = path.startsWith("/") ? path : `/${path}`;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

/**
 * `true` if `subPath` is the same as `systemPath` or lives under it.
 * Used to decide whether a per-subject override needs to be hidden from
 * the tools view (overrides outside systemPath are reachable via the
 * root and must be filtered out explicitly).
 */
export function isUnderSystem(subPath: string, systemPath: string): boolean {
  if (subPath === systemPath) return true;
  return subPath.startsWith(`${systemPath}/`);
}

/**
 * Translate an absolute per-subject path into a path relative to
 * systemFiles' root (which is `systemPath` after the `CompositeFilesApi`
 * rebase). If the override lives outside `systemPath`, return it
 * unchanged — system code passes it to the *underlying* `rootFiles` via
 * the system view (which delegates outside the rebase to the same
 * backend, just through the composite's mount logic).
 *
 * `defaultRelative` is used when the override is undefined.
 */
export function toSystemRelative(
  override: string | undefined,
  systemPath: string,
  defaultRelative: string,
): string {
  if (override === undefined) return defaultRelative;
  if (override === systemPath) return "/";
  if (override.startsWith(`${systemPath}/`)) {
    return override.slice(systemPath.length);
  }
  return override;
}

// ── Two-view FilesApi split ──────────────────────────────────────────────

/** System-relative paths for each subject, resolved by {@link buildFilesSplit}. */
export interface ResolvedPaths {
  sessions: string;
  skills: string;
  agents: string;
  config: string;
}

/** Per-subject path overrides accepted by {@link buildFilesSplit}. */
export interface FilesSplitOverrides {
  sessions?: string;
  skills?: string;
  agents?: string;
  config?: string;
}

/** Inputs for {@link buildFilesSplit}. */
export interface FilesSplitOptions {
  systemPath: string;
  userPath: string;
  overrides?: FilesSplitOverrides;
}

/** Result returned by {@link buildFilesSplit}. */
export interface FilesSplitResult {
  systemFiles: FilesApi;
  toolsFiles: FilesApi;
  paths: ResolvedPaths;
}

/**
 * Build the runtime's two FilesApi views over `rootFiles`:
 *
 * - `systemFiles` — full visibility, rooted at `systemPath`. A path like
 *   `/sessions` on `systemFiles` resolves to `<systemPath>/sessions` on
 *   `rootFiles`. Used by runtime-internal modules (config, sessions,
 *   skills, agents).
 * - `toolsFiles` — visibility restricted away from `systemPath`. When
 *   `userPath === "/"`, a `FilteredFilesApi` hides the system path-tree
 *   (plus any per-subject overrides outside it). When `userPath` is a
 *   subtree, a `CompositeFilesApi` rebases at `userPath` — everything
 *   outside (including `systemPath`) is naturally invisible.
 *
 * Plus the resolved system-relative `paths` for each subject (sessions,
 * skills, agents, config).
 *
 * Throws when `systemPath === '/' && userPath === '/'` because that
 * geometry would hide every path from tools.
 */
export function buildFilesSplit(rootFiles: FilesApi, opts: FilesSplitOptions): FilesSplitResult {
  const systemPath = opts.systemPath;
  const userPath = opts.userPath;
  const overrides = opts.overrides ?? {};

  if (systemPath === "/" && userPath === "/") {
    throw new Error(
      "buildFilesSplit: setSystemPath('/') with default userPath would hide every path from tools",
    );
  }

  const systemFiles = new CompositeFilesApi(rootFiles, systemPath);

  let toolsFiles: FilesApi;
  if (userPath === "/") {
    const hidePaths = [systemPath];
    for (const p of [overrides.sessions, overrides.skills, overrides.agents, overrides.config]) {
      if (p && !isUnderSystem(p, systemPath)) hidePaths.push(p);
    }
    toolsFiles = new FilteredFilesApi(rootFiles, combineFilters(...hidePaths.map(hideUnder)));
  } else {
    toolsFiles = new CompositeFilesApi(rootFiles, userPath);
  }

  const paths: ResolvedPaths = {
    sessions: toSystemRelative(overrides.sessions, systemPath, "/sessions"),
    skills: toSystemRelative(overrides.skills, systemPath, "/skills"),
    agents: toSystemRelative(overrides.agents, systemPath, "/agents"),
    config: toSystemRelative(overrides.config, systemPath, "/"),
  };

  return { systemFiles, toolsFiles, paths };
}
