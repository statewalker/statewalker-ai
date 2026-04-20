/** Normalize a virtual path so it always starts with "/" and has no double slashes. */
export function normalizePath(path: string): string {
  if (!path.startsWith("/")) path = `/${path}`;
  return path.replace(/\/+/g, "/");
}

export type PathFilter = (path: string) => boolean;

/**
 * Create a filter that returns true for paths that should be excluded.
 * Matches any path that starts with one of the given prefixes.
 */
export function createExcludedPathFilter(
  excludedPrefixes: readonly string[],
): PathFilter {
  const normalized = excludedPrefixes.map(normalizePath);
  return (path: string): boolean => {
    const p = normalizePath(path);
    return normalized.some(
      (prefix) => p.startsWith(prefix) || p === prefix.replace(/\/$/, ""),
    );
  };
}

/** Guard that throws if a path is excluded. Returns the normalized path. */
export function guardPath(path: string, isExcluded: PathFilter): string {
  const p = normalizePath(path);
  if (isExcluded(p)) {
    throw new PathExcludedError(p);
  }
  return p;
}

export class PathExcludedError extends Error {
  constructor(path: string) {
    super(`Access denied: path is excluded: ${path}`);
    this.name = "PathExcludedError";
  }
}
