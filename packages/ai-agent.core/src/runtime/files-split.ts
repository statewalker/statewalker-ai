import { type FilesApi, normalizePath } from "@statewalker/webrun-files";
import {
  CompositeFilesApi,
  FilteredFilesApi,
  type PathFilter,
} from "@statewalker/webrun-files-composite";

/**
 * Build a path filter that hides everything **at or under** `prefix`.
 * Boundary-aware: `/private` does not hide `/privacy`.
 */
function hideUnder(prefix: string): PathFilter {
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

/** Normalise a folder path: ensure leading slash, strip trailing slash. */
export function normalizeFolderPath(path: string): string {
  let p = path.startsWith("/") ? path : `/${path}`;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

// ── Two-view FilesApi split ──────────────────────────────────────────────

/** System-relative paths for each subject, resolved by {@link buildFilesSplit}. */
export interface ResolvedPaths {
  sessions: string;
  skills: string;
  agents: string;
  config: string;
}

/** Inputs for {@link buildFilesSplit}. */
export interface FilesSplitOptions {
  systemPath: string;
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
 * - `toolsFiles` — visibility restricted away from `systemPath` via
 *   `FilteredFilesApi`. Hidden paths reject writes / list-as-empty.
 *
 * Plus the resolved system-relative `paths` for each subject (sessions,
 * skills, agents, config), hard-coded to system-relative defaults.
 *
 * Throws when `systemPath === '/'` because hiding root would make every
 * path invisible to tools.
 */
export function buildFilesSplit(rootFiles: FilesApi, opts: FilesSplitOptions): FilesSplitResult {
  const systemPath = opts.systemPath;

  if (systemPath === "/") {
    throw new Error("buildFilesSplit: setSystemPath('/') would hide every path from tools");
  }

  const systemFiles = new CompositeFilesApi(rootFiles, systemPath);
  const toolsFiles = new FilteredFilesApi(rootFiles, hideUnder(systemPath));

  const paths: ResolvedPaths = {
    sessions: "/sessions",
    skills: "/skills",
    agents: "/agents",
    config: "/",
  };

  return { systemFiles, toolsFiles, paths };
}
