import type { ConnectionType } from "@statewalker/ai-providers";

/**
 * Curated default-starred set keyed by Connection `type`. Globs are
 * matched against `DiscoveredModel.id` (case-insensitive). On the
 * **first** successful Connect for a Connection (when its
 * `starredModelIds` is empty), any discovered model whose id matches
 * a glob here is added to the Connection's `starredModelIds`.
 * Subsequent Check Connection re-fetches do NOT re-apply this table
 * — user un-checks are durable.
 *
 * Glob syntax: simple wildcard. `*` matches any (possibly empty)
 * run of non-`/` characters. The implementation in `applyDefaults`
 * compiles each pattern into a `RegExp`. Patterns are
 * case-insensitive.
 *
 * `openai-compatible` deliberately ships **no** defaults — those
 * Connections target arbitrary endpoints with arbitrary model
 * inventories, so a curated default would be misleading.
 */
export const DEFAULT_STARRED_BY_TYPE: Readonly<Record<ConnectionType, readonly string[]>> =
  Object.freeze({
    google: Object.freeze(["gemini-1.5-*", "gemini-2.0-*", "gemini-2.5-*"]),
    openai: Object.freeze(["gpt-4*", "gpt-4o*", "o1-*", "o3-*"]),
    anthropic: Object.freeze(["claude-3-*", "claude-3.5-*", "claude-3-5-*", "claude-sonnet-*"]),
    "openai-compatible": Object.freeze([]),
  }) as Readonly<Record<ConnectionType, readonly string[]>>;

/** Compile a glob pattern (with `*` wildcards) into a case-insensitive
 * RegExp anchored at both ends. */
function globToRegExp(pattern: string): RegExp {
  // Escape regex metacharacters except `*`; then turn `*` into `.*`.
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

/** Resolve compiled regexps for a type. Memoised across calls. */
const COMPILED_CACHE = new Map<ConnectionType, RegExp[]>();
function compiled(type: ConnectionType): RegExp[] {
  let entry = COMPILED_CACHE.get(type);
  if (!entry) {
    entry = DEFAULT_STARRED_BY_TYPE[type].map(globToRegExp);
    COMPILED_CACHE.set(type, entry);
  }
  return entry;
}

/** Compute the default-starred set for a Connection of a given type
 * given the freshly-fetched model ids. The result preserves the
 * order in which model ids were discovered. */
export function applyDefaultStarred(type: ConnectionType, modelIds: readonly string[]): string[] {
  const regexps = compiled(type);
  if (regexps.length === 0) return [];
  const out: string[] = [];
  for (const id of modelIds) {
    if (regexps.some((rx) => rx.test(id))) out.push(id);
  }
  return out;
}
