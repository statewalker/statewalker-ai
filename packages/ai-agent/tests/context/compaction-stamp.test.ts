import { describe, expect, it } from "vitest";
import { isStampStale, LEGACY_STAMP, newStamp } from "../../src/context/compaction-stamp.js";
import {
  createAgentNodeFactory,
  NodeType,
  type SessionState,
  type TurnGroup,
} from "../../src/state/index.js";

function makeGroup(stamp?: string): TurnGroup {
  const factory = createAgentNodeFactory();
  const session = factory({ type: NodeType.session }) as SessionState;
  const group = session.addChild({ type: NodeType.turnGroup }) as TurnGroup;
  if (stamp !== undefined) group.stamp = stamp;
  return group;
}

describe("newStamp", () => {
  it("produces pairwise-distinct ids on successive calls", () => {
    const a = newStamp();
    const b = newStamp();
    const c = newStamp();
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("call order matches lexicographic order", () => {
    const ids = [newStamp(), newStamp(), newStamp(), newStamp()];
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
  });
});

describe("isStampStale", () => {
  it("treats an undefined stamp as stale", () => {
    const group = makeGroup();
    expect(isStampStale(group, newStamp())).toBe(true);
  });

  it("older real stamp is stale against a newer real stamp", () => {
    const older = newStamp();
    const newer = newStamp();
    const group = makeGroup(older);
    expect(isStampStale(group, newer)).toBe(true);
  });

  it("newer real stamp is not stale against an older real stamp", () => {
    const older = newStamp();
    const newer = newStamp();
    const group = makeGroup(newer);
    expect(isStampStale(group, older)).toBe(false);
  });

  it("equal real stamps are not stale", () => {
    const s = newStamp();
    const group = makeGroup(s);
    expect(isStampStale(group, s)).toBe(false);
  });

  it("legacy stamp is stale against any real stamp", () => {
    const group = makeGroup(LEGACY_STAMP);
    expect(isStampStale(group, newStamp())).toBe(true);
  });

  it("legacy stamp compared to legacy is not stale", () => {
    const group = makeGroup(LEGACY_STAMP);
    expect(isStampStale(group, LEGACY_STAMP)).toBe(false);
  });

  it("real stamp against legacy context is not stale", () => {
    // If a caller is asking 'is this group older than the legacy marker?',
    // a real stamp is considered newer than legacy — not stale.
    const group = makeGroup(newStamp());
    expect(isStampStale(group, LEGACY_STAMP)).toBe(false);
  });
});
