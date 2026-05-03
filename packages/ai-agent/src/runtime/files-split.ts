import { type FilesApi, normalizePath } from "@statewalker/webrun-files";
import { FilteredFilesApi, type PathFilter } from "@statewalker/webrun-files-composite";

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
 * The returned view is the one tools and skills receive via
 * `AgentContext.files`. Hidden paths are reported as not-existing (read /
 * list / stats / exists yield empty / false); writes / mkdir under hidden
 * paths reject with `"Path is hidden"`.
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
