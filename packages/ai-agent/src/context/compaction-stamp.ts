import { SnowflakeId } from "@statewalker/shared-ids";
import type { TurnGroup } from "../state/turn-group.js";

/**
 * Marker used by the compactor when wrapping a contiguous prefix of turns
 * that already carry the pre-hierarchical `turn.props.summary` string. The
 * legacy marker is lexicographically later than real snowflake stamps but
 * `isStampStale` treats it specially so the first real compaction pass
 * classifies legacy groups as stale.
 */
export const LEGACY_STAMP = "legacy" as const;

const sharedGenerator = new SnowflakeId();

/**
 * Generate a new compaction-pass stamp. Monotonic across calls within the
 * same process; lexicographic string comparison reflects creation order.
 */
export function newStamp(): string {
  return sharedGenerator.generate();
}

/**
 * Return `true` when `group.props.stamp` is older than `relativeTo`
 * (meaning the group's cached summary predates the current compaction pass
 * and should be re-evaluated).
 *
 * Semantics:
 *   - absent/undefined stamp on the group      → stale.
 *   - `relativeTo === LEGACY_STAMP`             → same-legacy is not stale,
 *                                                 a real stamp is not stale.
 *   - group stamp is the literal `LEGACY_STAMP` → stale against any real
 *                                                 (non-legacy) stamp.
 *   - otherwise                                 → plain lexicographic compare.
 */
export function isStampStale(group: TurnGroup, relativeTo: string): boolean {
  const groupStamp = group.stamp;
  if (groupStamp === undefined) return true;
  if (groupStamp === relativeTo) return false;
  if (groupStamp === LEGACY_STAMP) {
    return relativeTo !== LEGACY_STAMP;
  }
  if (relativeTo === LEGACY_STAMP) {
    return false;
  }
  return groupStamp < relativeTo;
}
