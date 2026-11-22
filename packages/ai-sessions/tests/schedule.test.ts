// Schedules of triggers (statewalker/statewalker-root#207, decision #160): cron in an IANA time zone
// or `at`, the minimum interval between fires, and the fires a stopped host missed. The worked
// examples are read off a calendar, never computed the way the code computes them.
import { describe, expect, it } from "vitest";
import { checkSchedule, dueFires, nextFire, parseCron } from "../src/schedule.js";

const MIN = 60_000;
const at = (iso: string) => Date.parse(iso);

describe("cron schedules", () => {
  it("fires at the next matching minute in the schedule's time zone", () => {
    // 09:00 every weekday in Berlin (CET, UTC+1 in January).
    const cron = parseCron("0 9 * * 1-5");
    // Friday 2026-01-09 10:00 Berlin → next is Monday 2026-01-12 09:00 Berlin = 08:00 UTC.
    expect(
      nextFire({ cron: "0 9 * * 1-5", timezone: "Europe/Berlin" }, at("2026-01-09T09:00:00Z")),
    ).toBe(at("2026-01-12T08:00:00Z"));
    expect(cron).toBeTruthy();
    // In summer Berlin is UTC+2: 09:00 is 07:00 UTC.
    expect(
      nextFire({ cron: "0 9 * * *", timezone: "Europe/Berlin" }, at("2026-07-01T12:00:00Z")),
    ).toBe(at("2026-07-02T07:00:00Z"));
    // UTC by default; steps, lists and ranges.
    expect(nextFire({ cron: "*/30 * * * *" }, at("2026-03-01T10:05:00Z"))).toBe(
      at("2026-03-01T10:30:00Z"),
    );
    expect(nextFire({ cron: "15 8,20 1 * *" }, at("2026-03-01T09:00:00Z"))).toBe(
      at("2026-03-01T20:15:00Z"),
    );
    // Names of months and days.
    expect(nextFire({ cron: "0 0 * feb sun" }, at("2026-01-15T00:00:00Z"))).toBe(
      at("2026-02-01T00:00:00Z"),
    );
  });

  it("crosses a daylight-saving change in the time zone", () => {
    // New York moves to EDT on 2026-03-08: 08:00 local is 13:00 UTC before, 12:00 UTC after.
    const s = { cron: "0 8 * * *", timezone: "America/New_York" };
    expect(nextFire(s, at("2026-03-07T14:00:00Z"))).toBe(at("2026-03-08T12:00:00Z"));
  });

  it("fires an `at` schedule once", () => {
    const s = { at: "2026-05-01T12:00:00Z" };
    expect(nextFire(s, at("2026-04-30T00:00:00Z"))).toBe(at("2026-05-01T12:00:00Z"));
    expect(nextFire(s, at("2026-05-01T12:00:00Z"))).toBeUndefined();
  });

  it("refuses a malformed schedule, an unknown zone and one firing more often than the minimum", () => {
    const now = at("2026-01-01T00:00:00Z");
    expect(() => checkSchedule({ cron: "61 * * * *" }, now, 15 * MIN)).toThrow(/EINVAL/);
    expect(() => checkSchedule({ cron: "* * *" }, now, 15 * MIN)).toThrow(/EINVAL/);
    expect(() =>
      checkSchedule({ cron: "0 * * * *", timezone: "Mars/Olympus" }, now, 15 * MIN),
    ).toThrow(/EINVAL/);
    expect(() => checkSchedule({ cron: "*/10 * * * *" }, now, 15 * MIN)).toThrow(/15 minutes/);
    expect(() => checkSchedule({ cron: "0,50 * * * *" }, now, 15 * MIN)).toThrow(/15 minutes/);
    expect(() => checkSchedule({ cron: "*/15 * * * *" }, now, 15 * MIN)).not.toThrow();
    expect(() => checkSchedule({ at: "2025-12-31T00:00:00Z" }, now, 15 * MIN)).toThrow(/EINVAL/);
    expect(() =>
      checkSchedule({ cron: "0 * * * *", at: "2026-02-01T00:00:00Z" }, now, 15 * MIN),
    ).toThrow(/EINVAL/);
    expect(() =>
      checkSchedule({ on_missed: "later", cron: "0 * * * *" } as never, now, 15 * MIN),
    ).toThrow(/EINVAL/);
  });
});

describe("fires missed while the host was stopped", () => {
  const s = { cron: "0 * * * *" };

  it("runs the latest missed fire once when it is within the hour, recording the others", () => {
    // Due since 10:00, the host back at 12:30: 10:00 and 11:00 are missed; 12:00 runs once.
    const d = dueFires(s, at("2026-01-01T10:00:00Z"), at("2026-01-01T12:30:00Z"));
    expect(d.run).toBe(at("2026-01-01T12:00:00Z"));
    expect(d.missed).toEqual([at("2026-01-01T10:00:00Z"), at("2026-01-01T11:00:00Z")]);
    expect(d.next).toBe(at("2026-01-01T13:00:00Z"));
  });

  it("runs nothing when the latest missed fire is older than an hour, or with on_missed skip", () => {
    const late = dueFires(
      { cron: "0 0 * * *" },
      at("2026-01-01T00:00:00Z"),
      at("2026-01-01T01:30:00Z"),
    );
    expect(late.run).toBeUndefined();
    expect(late.missed).toEqual([at("2026-01-01T00:00:00Z")]);
    const skip = dueFires(
      { ...s, on_missed: "skip" },
      at("2026-01-01T10:00:00Z"),
      at("2026-01-01T10:30:00Z"),
    );
    expect(skip.run).toBeUndefined();
    expect(skip.missed).toEqual([at("2026-01-01T10:00:00Z")]);
  });

  it("runs a fire due right now without calling it missed", () => {
    const d = dueFires(s, at("2026-01-01T10:00:00Z"), at("2026-01-01T10:00:20Z"));
    expect(d).toEqual({
      run: at("2026-01-01T10:00:00Z"),
      missed: [],
      next: at("2026-01-01T11:00:00Z"),
    });
  });
});
