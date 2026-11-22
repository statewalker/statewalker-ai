// A trigger's schedule (statewalker/statewalker-root#207, decision #160): a five-field cron
// expression in an IANA time zone (UTC by default), or one time (`at`). Fires are at least the
// deployment's minimum interval apart (15 minutes by default). A host that was stopped (CellB fires
// only while it runs) catches up per `on_missed`: `run_once` (the default) runs the latest missed
// fire if it is at most an hour old, `skip` runs none; every other missed fire is recorded.
import { codedError } from "@statewalker/ai-access";

export interface TriggerSchedule {
  /** `minute hour day-of-month month day-of-week`: numbers, `*`, lists, ranges, steps, names. */
  cron?: string;
  /** One fire: an ISO time, or ms since the epoch. */
  at?: string | number;
  /** The cron's IANA time zone (UTC by default). */
  timezone?: string;
  /** What a host that was stopped does with the fires it missed: `run_once` (default) or `skip`. */
  on_missed?: "run_once" | "skip";
}

const MIN = 60_000;
const HOUR = 60 * MIN;
/** How late a fire may run and still be on time (an alarm runs a little late). */
export const ON_TIME_MS = 2 * MIN;
/** The window `run_once` catches a missed fire up in. */
export const CATCH_UP_MS = HOUR;
/** Missed fires recorded per catch-up, at most (the latest ones). */
export const MAX_MISSED = 100;

interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domAny: boolean;
  dowAny: boolean;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function field(text: string, lo: number, hi: number, names?: string[], base = 0): Set<number> {
  const out = new Set<number>();
  const value = (v: string): number => {
    const named = names?.indexOf(v.toLowerCase()) ?? -1;
    if (named >= 0) return named + base;
    if (!/^\d+$/.test(v)) throw codedError("EINVAL", `cron: '${v}' is not a number`);
    return Number(v);
  };
  for (const part of text.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1 || (stepText !== undefined && !/^\d+$/.test(stepText)))
      throw codedError("EINVAL", `cron: bad step in '${part}'`);
    let from: number;
    let to: number;
    if (range === "*") [from, to] = [lo, hi];
    else if (range?.includes("-")) {
      const [a, b] = range.split("-");
      [from, to] = [value(String(a)), value(String(b))];
    } else {
      from = value(String(range));
      to = stepText === undefined ? from : hi;
    }
    if (from < lo || to > hi || from > to)
      throw codedError("EINVAL", `cron: '${part}' is outside ${lo}-${hi}`);
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
}

/** Parses a five-field cron expression; EINVAL when it is not one. */
export function parseCron(text: string): CronFields {
  const parts = String(text ?? "")
    .trim()
    .split(/\s+/);
  if (parts.length !== 5) throw codedError("EINVAL", "cron: five fields are required");
  const [mi, h, dom, mo, dow] = parts as [string, string, string, string, string];
  const days = field(dow, 0, 7, DAYS);
  // 7 is Sunday too.
  if (days.delete(7)) days.add(0);
  return {
    minute: field(mi, 0, 59),
    hour: field(h, 0, 23),
    dom: field(dom, 1, 31),
    month: field(mo, 1, 12, MONTHS, 1),
    dow: days,
    domAny: dom === "*",
    dowAny: dow === "*",
  };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        weekday: "short",
      });
    } catch {
      throw codedError("EINVAL", `'${timeZone}' is not an IANA time zone`);
    }
    formatters.set(timeZone, f);
  }
  return f;
}

interface Local {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  dow: number;
}

function local(t: number, tz: string): Local {
  const parts = Object.fromEntries(
    formatter(tz)
      .formatToParts(t)
      .map((p) => [p.type, p.value]),
  );
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    h: Number(parts.hour) % 24,
    mi: Number(parts.minute),
    dow: DAYS.indexOf(String(parts.weekday).toLowerCase().slice(0, 3)),
  };
}

/** The instant of a wall time in the zone (the first one, or the one after a gap). */
function instant(y: number, m: number, d: number, h: number, mi: number, tz: string): number {
  const wall = Date.UTC(y, m - 1, d, h, mi);
  const offsetAt = (t: number) => {
    const l = local(t, tz);
    return Date.UTC(l.y, l.m - 1, l.d, l.h, l.mi) - Math.floor(t / MIN) * MIN;
  };
  let t = wall - offsetAt(wall);
  const again = wall - offsetAt(t);
  if (again !== t) t = Math.max(again, t);
  return t;
}

function matchesDay(c: CronFields, l: Local): boolean {
  const dom = c.dom.has(l.d);
  const dow = c.dow.has(l.dow);
  // Both restricted: either matches (cron's rule); otherwise the restricted one decides.
  if (!c.domAny && !c.dowAny) return dom || dow;
  return dom && dow;
}

function nextCron(c: CronFields, after: number, tz: string): number | undefined {
  let t = Math.floor(after / MIN) * MIN + MIN;
  for (let i = 0; i < 100_000; i++) {
    const l = local(t, tz);
    if (!c.month.has(l.m)) {
      const [y, m] = l.m === 12 ? [l.y + 1, 1] : [l.y, l.m + 1];
      t = Math.max(t + MIN, instant(y, m, 1, 0, 0, tz));
      continue;
    }
    if (!matchesDay(c, l)) {
      const next = new Date(Date.UTC(l.y, l.m - 1, l.d + 1));
      t = Math.max(
        t + MIN,
        instant(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, tz),
      );
      continue;
    }
    if (!c.hour.has(l.h)) {
      t += (60 - l.mi) * MIN;
      continue;
    }
    if (!c.minute.has(l.mi)) {
      t += MIN;
      continue;
    }
    return t;
  }
  return undefined;
}

function atOf(s: TriggerSchedule): number | undefined {
  if (s.at === undefined) return undefined;
  const t = typeof s.at === "number" ? s.at : Date.parse(String(s.at));
  if (!Number.isFinite(t)) throw codedError("EINVAL", "at is an ISO time or ms since the epoch");
  return t;
}

/** The schedule's first fire after `after` (ms), or undefined when it fires no more. */
export function nextFire(s: TriggerSchedule, after: number): number | undefined {
  const at = atOf(s);
  if (at !== undefined) return at > after ? at : undefined;
  return nextCron(parseCron(String(s.cron)), after, s.timezone ?? "UTC");
}

/**
 * Checks a schedule: one of `cron` or `at`, a known time zone, `on_missed` one of its values, an
 * `at` in the future, and cron fires at least `minIntervalMs` apart; EINVAL otherwise. Answers the
 * schedule as stored and its first fire.
 */
export function checkSchedule(
  raw: unknown,
  now: number,
  minIntervalMs: number,
): { schedule: TriggerSchedule; next: number | undefined } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw codedError("EINVAL", "a schedule trigger takes a schedule: {cron, timezone?} or {at}");
  const s = raw as Record<string, unknown>;
  const hasCron = s.cron !== undefined;
  const hasAt = s.at !== undefined;
  if (hasCron === hasAt) throw codedError("EINVAL", "a schedule is either cron or at");
  if (s.on_missed !== undefined && s.on_missed !== "run_once" && s.on_missed !== "skip")
    throw codedError("EINVAL", "on_missed is run_once or skip");
  const schedule: TriggerSchedule = {
    ...(hasCron ? { cron: String(s.cron) } : {}),
    ...(hasAt ? { at: s.at as string | number } : {}),
    ...(s.timezone !== undefined ? { timezone: String(s.timezone) } : {}),
    ...(s.on_missed !== undefined ? { on_missed: s.on_missed as "run_once" | "skip" } : {}),
  };
  if (schedule.timezone !== undefined) formatter(schedule.timezone);
  if (hasAt) {
    const at = atOf(schedule) as number;
    if (at <= now) throw codedError("EINVAL", "at is in the past");
    return { schedule, next: at };
  }
  if (typeof s.cron !== "string") throw codedError("EINVAL", "cron is a string");
  const first = nextFire(schedule, now);
  // The gaps between the next fires: a schedule repeats within a year at most.
  let prev = first;
  for (let i = 0; prev !== undefined && i < 200; i++) {
    const next = nextFire(schedule, prev);
    if (next === undefined) break;
    if (next - prev < minIntervalMs)
      throw codedError(
        "EINVAL",
        `a schedule fires at most every ${Math.round(minIntervalMs / MIN)} minutes`,
      );
    prev = next;
  }
  return { schedule, next: first };
}

/**
 * What is due of a schedule whose next fire was `due`, now: the fire to run (if any), the fires
 * missed (recorded, at most `MAX_MISSED`, the latest), and the next fire after now.
 */
export function dueFires(
  s: TriggerSchedule,
  due: number,
  now: number,
): { run?: number; missed: number[]; next: number | undefined } {
  const times: number[] = [];
  let t: number | undefined = due;
  let skipped = 0;
  while (t !== undefined && t <= now && skipped < 100_000) {
    times.push(t);
    if (times.length > MAX_MISSED + 1) times.shift();
    skipped++;
    t = nextFire(s, t);
  }
  const next = t;
  const last = times.at(-1);
  if (last === undefined) return { missed: [], next };
  const window = (s.on_missed ?? "run_once") === "run_once" ? CATCH_UP_MS : ON_TIME_MS;
  if (now - last <= Math.max(window, ON_TIME_MS))
    return { run: last, missed: times.slice(0, -1).slice(-MAX_MISSED), next };
  return { missed: times.slice(-MAX_MISSED), next };
}
