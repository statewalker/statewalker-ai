// File pre-images (statewalker/statewalker-root#191): what the session API can't show at its seam is
// checked here: the 30-day age of pre-images (the clock), a project's deletion dropping them, and
// a digest that does not depend on how content was chunked.
import { DatabaseSync } from "node:sqlite";
import { readText, writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import {
  ContentDigest,
  DEFAULT_PRE_IMAGE_RETENTION,
  PreImageLog,
  parsePreImageRetention,
  preImaged,
  type SqlLike,
  type StorageDelta,
} from "../src/index.js";

const sqlite = (): SqlLike => {
  const db = new DatabaseSync(":memory:");
  return {
    exec: (query, ...bindings) => {
      const rows = db.prepare(query).all(...(bindings as never[]));
      return { toArray: () => rows as Record<string, unknown>[] };
    },
  };
};

const DAY = 24 * 3600_000;

function setup() {
  let now = 1_000_000;
  const log = new PreImageLog(sqlite(), { now: () => now });
  const store = new MemFilesApi();
  const meter: StorageDelta[] = [];
  const as = (turn: string, session = "s1", lineage = ["s1"]) =>
    preImaged(store, {
      log,
      actor: { session, lineage, turn },
      retention: () => DEFAULT_PRE_IMAGE_RETENTION,
      adjust: (d) => {
        meter.push(...d);
      },
    });
  return {
    log,
    store,
    meter,
    as,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("pre-images", () => {
  it("reads a retention leniently over the deployment's", () => {
    const base = { maxAgeMs: 7 * DAY, maxBytes: 10 };
    expect(parsePreImageRetention(undefined, base)).toEqual(base);
    expect(parsePreImageRetention("not json", base)).toEqual(base);
    expect(parsePreImageRetention('{"days": 1, "megabytes": "x"}', base)).toEqual({
      maxAgeMs: DAY,
      maxBytes: 10,
    });
    expect(parsePreImageRetention('{"megabytes": 2}')).toEqual({
      maxAgeMs: 30 * DAY,
      maxBytes: 2 * 1024 * 1024,
    });
  });

  it("digests content the same however it is chunked", async () => {
    const bytes = new Uint8Array(3 * 1024 * 1024 + 5).map((_, i) => i % 251);
    const whole = new ContentDigest();
    whole.push(bytes);
    const parts = new ContentDigest();
    for (let i = 0; i < bytes.length; i += 77_777) parts.push(bytes.subarray(i, i + 77_777));
    expect(await parts.done()).toBe(await whole.done());
    const other = new ContentDigest();
    other.push(bytes.subarray(1));
    expect(await other.done()).not.toBe(await whole.done());
  });

  it("frees pre-images older than the retention's age: their files can no longer be reverted", async () => {
    const { log, store, as, advance, meter } = setup();
    await writeText(store, "/p/a.md", "a0");
    await writeText(store, "/p/b.md", "b0");
    await writeText(as("s1.tu-1"), "/p/a.md", "a1");
    advance(29 * DAY);
    await writeText(as("s1.tu-2"), "/p/b.md", "b1");
    advance(2 * DAY);
    const freed = log.prune("s1", DEFAULT_PRE_IMAGE_RETENTION);
    expect(freed).toEqual([{ project: "p", bytes: -2 }]);
    expect(meter).toEqual([
      { project: "p", bytes: 2 },
      { project: "p", bytes: 2 },
    ]);
    const plan = await log.plan(store, {
      session: "s1",
      turns: ["s1.tu-1", "s1.tu-2"],
      children: [],
    });
    expect(plan).toMatchObject({ reverted: ["/p/b.md"], unavailable: ["/p/a.md"], conflicts: [] });
    expect(await log.apply(store, plan)).toEqual({
      reverted: ["/p/b.md"],
      conflicts: [],
      unavailable: ["/p/a.md"],
    });
    expect(await readText(store, "/p/b.md")).toBe("b0");
    expect(await readText(store, "/p/a.md")).toBe("a1");
  });

  it("drops a project's records and pre-images when the project is deleted", async () => {
    const { log, store, as } = setup();
    await writeText(store, "/p/a.md", "a0");
    await writeText(store, "/q/a.md", "q0");
    await writeText(as("s1.tu-1"), "/p/a.md", "a1");
    await writeText(as("s1.tu-1"), "/q/a.md", "q1");
    expect(log.drop({ project: "p" })).toEqual([{ project: "p", bytes: -2 }]);
    const plan = await log.plan(store, { session: "s1", turns: ["s1.tu-1"], children: [] });
    expect(plan).toMatchObject({ reverted: ["/q/a.md"], conflicts: [], unavailable: [] });
  });

  it("counts a sub-agent's changes only for its own ancestors' reverts", async () => {
    const { log, store, as } = setup();
    await writeText(store, "/p/a.md", "a0");
    await writeText(as("c1.tu-1", "c1", ["s1", "c1"]), "/p/a.md", "a1");
    const other = await log.plan(store, { session: "s2", turns: [], children: ["c1"] });
    expect(other.reverted).toEqual([]);
    const own = await log.plan(store, { session: "s1", turns: [], children: ["c1"] });
    expect(own.reverted).toEqual(["/p/a.md"]);
  });
});
