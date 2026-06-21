import type { ConnectionType } from "../public/types.js";

/**
 * Curated default-starred set keyed by Connection `type`. Globs are
 * matched against `DiscoveredModel.id` (case-insensitive). On the
 * **first** successful Connect for a Connection (when its
 * `starredModelIds` is empty), any discovered model whose id matches
 * a glob here is added to the Connection's `starredModelIds`.
 * Subsequent re-discovery does NOT re-apply this table — user
 * un-checks are durable.
 *
 * Glob syntax: simple wildcard. `*` matches any (possibly empty)
 * run of non-`/` characters. The implementation in `applyDefaultStarred`
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

/** The date encoded by a pinned snapshot's first all-digit segment (≥ 4 long) —
 * `gpt-4-0613` → 613, `claude-3-5-sonnet-20240620` → 20240620 — or `0` when the
 * id carries no date (a rolling release alias like `gpt-4` / `gpt-4o`). The
 * curated families never use a bare 4-digit segment for anything but a date. */
function snapshotDate(id: string): number {
  const seg = id.split(/[-_]/).find((s) => /^\d{4,}$/.test(s));
  return seg ? Number(seg) : 0;
}

/** The family of a model id: everything up to (but excluding) its date segment.
 * `gpt-4-0613` and `gpt-4` share family `gpt-4`; `claude-3-5-sonnet-20240620`
 * → `claude-3-5-sonnet`; `gpt-4o` / `gpt-4-turbo` are their own families. */
function familyOf(id: string): string {
  const parts = id.split("-");
  const out: string[] = [];
  for (const p of parts) {
    if (/^\d{4,}$/.test(p)) break;
    out.push(p);
  }
  return out.join("-");
}

/** Reduce matched ids to **one release per family**: the undated rolling alias
 * when the provider exposes one (`gpt-4` over `gpt-4-0613`), otherwise the
 * latest pinned snapshot (Anthropic only ships dated ids, so `claude-3-5-sonnet`
 * resolves to its newest `…-YYYYMMDD`). Families appear in discovery order. */
function pickReleaseVersions(matched: readonly string[]): string[] {
  const families: string[] = [];
  const byFamily = new Map<string, string[]>();
  for (const id of matched) {
    const fam = familyOf(id);
    let ids = byFamily.get(fam);
    if (!ids) {
      ids = [];
      byFamily.set(fam, ids);
      families.push(fam);
    }
    ids.push(id);
  }
  const out: string[] = [];
  for (const fam of families) {
    const ids = byFamily.get(fam) ?? [];
    const alias = ids.find((id) => id === fam);
    if (alias) {
      out.push(alias);
      continue;
    }
    let best = ids[0] as string;
    for (const id of ids) {
      if (snapshotDate(id) > snapshotDate(best)) best = id;
    }
    out.push(best);
  }
  return out;
}

/** Compute the default-starred set for a Connection of a given type given the
 * freshly-fetched model ids: the curated globs select candidate families, then
 * `pickReleaseVersions` keeps only the latest release of each (no pinned/dated
 * duplicates). The result preserves family discovery order. */
export function applyDefaultStarred(type: ConnectionType, modelIds: readonly string[]): string[] {
  const regexps = compiled(type);
  if (regexps.length === 0) return [];
  const matched = modelIds.filter((id) => regexps.some((rx) => rx.test(id)));
  return pickReleaseVersions(matched);
}
