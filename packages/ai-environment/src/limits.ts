// Meters, limits and usage records (statewalker/statewalker-root#179, decision #158). A meter is one
// kind of resource counted in its own unit; a limit caps one meter at one level, per period; a
// usage record is one metered event naming its workspace, project, user, session and turn.
//
// Each level's counters live in the Durable Object that owns it (session: the Agent DO; project,
// member and workspace: the Workspace DO; the user's own keys: the User DO), each keeping one
// `LimitLedger` over its own SQLite. There is no global counter: a deployment limit is a ceiling
// each workspace (and each user, for their own keys) is held to in its own DO.
//
// New tables only: limit_counters, limit_reservations, limit_raises, limit_warned, usage_records
// and limit_meta. Rolling back leaves them unused.
import type { SqlLike } from "./sql.js";

/** The meters, each in its natural unit. `executor_cpu_ms` takes a kind: `executor_cpu_ms:node`. */
export const METERS = [
  "model_spend",
  "model_tokens",
  "tool_calls",
  "executor_cpu_ms",
  "outbound_requests",
  "outbound_bytes",
  "storage_bytes",
  "sessions",
  "streams",
  "turns",
] as const;

export type Meter = (typeof METERS)[number] | `executor_cpu_ms:${string}`;

/** Meters of what is held now (bytes stored, sessions active, streams open), not of a flow. */
const GAUGES: readonly string[] = ["storage_bytes", "sessions", "streams"];

export const LIMIT_LEVELS = [
  "deployment",
  "workspace",
  "project",
  "member",
  "user",
  "session",
] as const;

/** deployment, workspace, project, user in a workspace (`member`), user across the deployment (their own keys: `user`), agent session. */
export type LimitLevel = (typeof LIMIT_LEVELS)[number];

/** The levels whose limits may ask: the others always deny. */
export const ASK_LEVELS: readonly LimitLevel[] = ["session", "member", "user"];

export const PERIODS = ["second", "minute", "hour", "day", "month", "total"] as const;
export type Period = (typeof PERIODS)[number];

export type OnExceed = "deny" | "ask" | "delay";

export interface Limit {
  meter: Meter;
  level: LimitLevel;
  /** The level's target it caps (a project, a member, a session); none: each one of the level. */
  target?: string;
  value: number;
  period: Period;
  on_exceed: OnExceed;
  /** The share of the limit at which a warning is left: 0.8 by default. */
  warn_at: number;
  /** What one approval of an `ask` adds: the limit's value by default. */
  increment?: number;
}

export function isMeter(value: unknown): value is Meter {
  if (typeof value !== "string") return false;
  if ((METERS as readonly string[]).includes(value)) return true;
  return /^executor_cpu_ms:[a-z0-9][a-z0-9_-]{0,31}$/.test(value);
}

export const isGauge = (meter: string): boolean => GAUGES.includes(meter);

/**
 * Limits from JSON (a list, or `{limits: [...]}`), leniently: what is not a limit is reported and
 * left out; an `ask` where only `deny` applies (workspace, project, deployment) denies, and a
 * gauge counts its total whatever period is named.
 */
/**
 * The meters an agent session's DO counts: a session limit on another (storage, streams, sessions,
 * outbound bytes) would never hold, so it is refused.
 */
export function isSessionMeter(meter: string): boolean {
  return (
    ["turns", "tool_calls", "model_spend", "model_tokens", "outbound_requests"].includes(meter) ||
    meter === "executor_cpu_ms" ||
    meter.startsWith("executor_cpu_ms:")
  );
}

export function parseLimits(text: unknown): { limits: Limit[]; problems: string[] } {
  if (text === undefined || text === null || text === "") return { limits: [], problems: [] };
  let value: unknown = text;
  if (typeof text === "string") {
    try {
      value = JSON.parse(text);
    } catch {
      return { limits: [], problems: ["limits are not JSON"] };
    }
  }
  const list = Array.isArray(value)
    ? value
    : Array.isArray((value as { limits?: unknown })?.limits)
      ? (value as { limits: unknown[] }).limits
      : undefined;
  if (!list) return { limits: [], problems: ["limits are a list"] };
  const limits: Limit[] = [];
  const problems: string[] = [];
  for (const [i, raw] of list.entries()) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const where = `limit ${i}`;
    if (!isMeter(r.meter)) {
      problems.push(`${where}: no meter '${String(r.meter)}'`);
      continue;
    }
    if (!(LIMIT_LEVELS as readonly unknown[]).includes(r.level)) {
      problems.push(`${where}: no level '${String(r.level)}'`);
      continue;
    }
    if (typeof r.value !== "number" || !Number.isFinite(r.value) || r.value < 0) {
      problems.push(`${where}: the value is a number of at least 0`);
      continue;
    }
    if (r.target !== undefined && (typeof r.target !== "string" || !r.target)) {
      problems.push(`${where}: the target is a name`);
      continue;
    }
    const level = r.level as LimitLevel;
    if (level === "session" && !isSessionMeter(r.meter)) {
      problems.push(`${where}: the session level does not count ${r.meter}`);
      continue;
    }
    let period: Period = (PERIODS as readonly unknown[]).includes(r.period)
      ? (r.period as Period)
      : "total";
    if (r.period !== undefined && !(PERIODS as readonly unknown[]).includes(r.period)) {
      problems.push(`${where}: no period '${String(r.period)}'`);
      continue;
    }
    if (isGauge(r.meter) && period !== "total") {
      problems.push(`${where}: ${r.meter} is what is held now: its period is total`);
      period = "total";
    }
    let onExceed: OnExceed = (["deny", "ask", "delay"] as unknown[]).includes(r.on_exceed)
      ? (r.on_exceed as OnExceed)
      : "deny";
    if (onExceed === "ask" && !ASK_LEVELS.includes(level)) {
      problems.push(`${where}: only session and user limits ask; a ${level} limit denies`);
      onExceed = "deny";
    }
    let warnAt = 0.8;
    if (typeof r.warn_at === "number" && r.warn_at > 0 && r.warn_at <= 100)
      warnAt = r.warn_at > 1 ? r.warn_at / 100 : r.warn_at;
    const limit: Limit = {
      meter: r.meter,
      level,
      ...(typeof r.target === "string" ? { target: r.target } : {}),
      value: r.value,
      period,
      on_exceed: onExceed,
      warn_at: warnAt,
      ...(typeof r.increment === "number" && r.increment > 0 ? { increment: r.increment } : {}),
    };
    limits.push(limit);
  }
  return { limits, problems };
}

/** The limits that cap one target of a level: those naming it, and those naming none. */
export function limitsFor(limits: readonly Limit[], level: LimitLevel, target: string): Limit[] {
  return limits.filter((l) => l.level === level && (l.target === undefined || l.target === target));
}

const FORMATS = new Map<string, Intl.DateTimeFormat>();

function localParts(t: number, timeZone: string) {
  let f = FORMATS.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    FORMATS.set(timeZone, f);
  }
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(t))
    if (part.type !== "literal") p[part.type] = Number(part.value);
  return {
    year: p.year ?? 1970,
    month: p.month ?? 1,
    day: p.day ?? 1,
    hour: (p.hour ?? 0) % 24,
    minute: p.minute ?? 0,
    second: p.second ?? 0,
  };
}

/** The zone's offset from UTC at instant t, in ms. */
function offsetAt(t: number, timeZone: string): number {
  const p = localParts(t, timeZone);
  return (
    Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000
  );
}

/** The instant a local calendar date starts in the zone. */
function localMidnight(year: number, month: number, day: number, timeZone: string): number {
  const guess = Date.UTC(year, month - 1, day);
  const first = guess - offsetAt(guess, timeZone);
  return guess - offsetAt(first, timeZone);
}

/** The window of a period holding instant `now`: calendar days and months in the time zone. */
export function windowOf(
  period: Period,
  now: number,
  timeZone = "UTC",
): { start: number; reset: number } {
  const step = { second: 1_000, minute: 60_000, hour: 3_600_000 } as Record<string, number>;
  if (period === "total") return { start: 0, reset: Number.POSITIVE_INFINITY };
  const ms = step[period];
  if (ms) {
    const start = Math.floor(now / ms) * ms;
    return { start, reset: start + ms };
  }
  const p = localParts(now, timeZone);
  if (period === "day")
    return {
      start: localMidnight(p.year, p.month, p.day, timeZone),
      reset: localMidnight(p.year, p.month, p.day + 1, timeZone),
    };
  return {
    start: localMidnight(p.year, p.month, 1, timeZone),
    reset: localMidnight(p.year, p.month + 1, 1, timeZone),
  };
}

/** One target of one level, and the limits that cap it, as the owning DO charges it. */
export interface LimitScope {
  level: LimitLevel;
  target: string;
  limits: Limit[];
}

/** Who a charge is for: every usage record names them. */
export interface UsageMeta {
  workspace: string;
  project: string;
  user: string;
  session?: string;
  turn?: string;
}

export interface UsageRecord extends UsageMeta {
  seq: number;
  meter: Meter;
  amount: number;
  /** Ids, sizes and outcomes only (a model, a tool's name), never content. */
  detail?: Record<string, unknown>;
  created: number;
}

/** A limit that a charge would cross, as said to the holder. */
export interface LimitBreach {
  limit: Limit;
  level: LimitLevel;
  target: string;
  used: number;
  /** The limit's value now, with the increments approvals added in this window. */
  value: number;
  verdict: "deny" | "ask" | "delay";
  /** The counter the limit reads: what an approval raises. */
  key: string;
  increment: number;
  /** When the window resets (ms from now); none for a total. */
  retryAfterMs?: number;
}

/** One limit as it holds a scope now: what is used, reserved and left of it, and when it resets. */
export interface LimitState {
  meter: Meter;
  level: LimitLevel;
  target: string;
  /** The limit's own level: a deployment ceiling held by a workspace says `deployment`. */
  limit_level: LimitLevel;
  period: Period;
  on_exceed: OnExceed;
  warn_at: number;
  /** The limit's value now, with the increments approvals added in this window. */
  value: number;
  used: number;
  reserved: number;
  /** What is left before the limit refuses: never below 0. */
  remaining: number;
  /** When the window resets (ms since the epoch); none for a total. */
  reset?: number;
}

/** A warning left once per window when usage crosses a limit's `warn_at`. */
export interface LimitWarning {
  limit: Limit;
  level: LimitLevel;
  target: string;
  used: number;
  value: number;
}

const describe = (b: Pick<LimitBreach, "limit" | "level" | "target" | "value">) => {
  const whose =
    b.limit.level === b.level
      ? `the ${b.level} ${b.target}'s limit`
      : `the ${b.limit.level} limit for the ${b.level} ${b.target}`;
  const per = b.limit.period === "total" ? "" : ` per ${b.limit.period}`;
  return `${whose} of ${b.value} ${b.limit.meter}${per}`;
};

const retryText = (b: LimitBreach) =>
  b.retryAfterMs === undefined ? "" : `; retry after ${Math.ceil(b.retryAfterMs / 1000)} s`;

/** A charge refused by a limit (`ELIMIT: …`). */
export class LimitExceeded extends Error {
  readonly code = "ELIMIT";
  readonly breach: LimitBreach;

  constructor(breach: LimitBreach) {
    super(`ELIMIT: ${describe(breach)} is reached${retryText(breach)}`);
    this.breach = breach;
  }

  get limit(): Limit {
    return this.breach.limit;
  }
  get verdict() {
    return this.breach.verdict;
  }
  get key() {
    return this.breach.key;
  }
  get increment() {
    return this.breach.increment;
  }
}

/** What a breach says, for a message across Durable Objects: `<text> [limit <json>]`. */
export function breachText(breach: LimitBreach): string {
  return `${describe(breach)} is reached [limit ${JSON.stringify({
    meter: breach.limit.meter,
    level: breach.level,
    target: breach.target,
    value: breach.value,
    period: breach.limit.period,
    used: breach.used,
    verdict: breach.verdict,
    key: breach.key,
    increment: breach.increment,
  })}]${retryText(breach)}`;
}

/** The limit a message carrying `[limit {...}]` names. */
export function limitOfMessage(message: string): Record<string, unknown> | undefined {
  const m = /\[limit (\{.*\})\]/.exec(message);
  if (!m?.[1]) return undefined;
  try {
    return JSON.parse(m[1]) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Which usage records a report sums: created in `[from, until)`, of a workspace, project, user. */
export interface UsageFilter {
  from: number;
  until: number;
  workspace?: string;
  project?: string;
  user?: string;
}

/** Usage summed per project, user, session, model and meter in a quarter-hour bucket. */
export interface UsageRow {
  project: string;
  user: string;
  session?: string;
  model?: string;
  /** Missing for usage whose amounts are not shown (another user's own key). */
  meter?: string;
  bucket: number;
  amount?: number;
}

const BUCKET_MS = 15 * 60_000;

/** What usage reports group by (statewalker/statewalker-root#181). */
export const USAGE_GROUPS = ["project", "user", "agent", "model", "day"] as const;
export type UsageGroupBy = (typeof USAGE_GROUPS)[number];

/** Usage totals of one group: what it is keyed by, and each meter's amount. */
export interface UsageGroup {
  key: Partial<Record<UsageGroupBy, string>>;
  /** Each meter's amount; none for usage under a user's own key seen by anyone but that user. */
  usage?: Record<string, number>;
  /** Usage under the user's own key. */
  own_key?: true;
}

/** A local calendar date (`YYYY-MM-DD`) in the time zone. */
export function localDay(t: number, timeZone = "UTC"): string {
  const p = localParts(t, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/**
 * Groups usage rows by the keys asked for, summing each meter: rows without a meter (amounts not
 * shown) make a group with no usage. `ownKey` marks every group as usage on the user's own key.
 */
export function groupUsage(
  rows: readonly UsageRow[],
  groupBy: readonly UsageGroupBy[],
  options: { timeZone?: string; agentOf?: (session: string) => string; ownKey?: boolean } = {},
): UsageGroup[] {
  const groups = new Map<string, UsageGroup>();
  for (const row of rows) {
    const key: UsageGroup["key"] = {};
    for (const by of groupBy) {
      const value =
        by === "day"
          ? localDay(row.bucket, options.timeZone)
          : by === "agent"
            ? row.session
              ? options.agentOf?.(row.session)
              : undefined
            : row[by];
      if (value) key[by] = value;
    }
    const id = JSON.stringify(groupBy.map((by) => key[by] ?? null));
    let group = groups.get(id);
    if (!group) {
      group = { key, ...(options.ownKey ? { own_key: true as const } : {}) };
      groups.set(id, group);
    }
    if (row.meter !== undefined) {
      group.usage ??= {};
      group.usage[row.meter] = (group.usage[row.meter] ?? 0) + (row.amount ?? 0);
    }
  }
  return [...groups.values()];
}

export interface LedgerOptions {
  /** The deployment's time zone, for calendar days and months (UTC). */
  timeZone?: string;
  /** How long usage records are kept (13 months). */
  retentionMonths?: number;
  now?: () => number;
}

interface Entry {
  level: LimitLevel;
  target: string;
  meter: string;
  period: Period;
  window: number;
  amount: number;
}

const keyOf = (e: Omit<Entry, "amount">) =>
  JSON.stringify([e.level, e.target, e.meter, e.period, e.window]);

const DAY = 86_400_000;

export class LimitLedger {
  readonly #sql: SqlLike;
  readonly #tz: string;
  readonly #retention: number;
  readonly #now: () => number;

  constructor(sql: SqlLike, options: LedgerOptions = {}) {
    this.#sql = sql;
    this.#tz = options.timeZone || "UTC";
    this.#retention = options.retentionMonths ?? 13;
    this.#now = options.now ?? Date.now;
    sql.exec(`CREATE TABLE IF NOT EXISTS limit_counters (level TEXT NOT NULL, target TEXT NOT NULL,
      meter TEXT NOT NULL, period TEXT NOT NULL, window INTEGER NOT NULL, used REAL NOT NULL,
      reserved REAL NOT NULL, PRIMARY KEY (level, target, meter, period, window))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS limit_reservations (id TEXT PRIMARY KEY,
      scopes TEXT NOT NULL, entries TEXT NOT NULL, created INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS limit_raises (key TEXT PRIMARY KEY, amount REAL NOT NULL,
      window INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS limit_warned (key TEXT PRIMARY KEY,
      window INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS usage_records (seq INTEGER PRIMARY KEY AUTOINCREMENT,
      created INTEGER NOT NULL, meter TEXT NOT NULL, amount REAL NOT NULL, workspace TEXT NOT NULL,
      project TEXT NOT NULL, user TEXT NOT NULL, session TEXT, turn TEXT, detail TEXT)`);
    sql.exec("CREATE TABLE IF NOT EXISTS limit_meta (name TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }

  #window(period: Period, now = this.#now()) {
    return windowOf(period, now, this.#tz);
  }

  #counter(e: Omit<Entry, "amount">): { used: number; reserved: number } {
    const row = this.#sql
      .exec(
        "SELECT used, reserved FROM limit_counters WHERE level = ? AND target = ? AND meter = ? AND period = ? AND window = ?",
        e.level,
        e.target,
        e.meter,
        e.period,
        e.window,
      )
      .toArray()[0];
    return { used: Number(row?.used ?? 0), reserved: Number(row?.reserved ?? 0) };
  }

  #bump(e: Omit<Entry, "amount">, used: number, reserved: number): void {
    const args = [e.level, e.target, e.meter, e.period, e.window];
    this.#sql.exec(
      `INSERT INTO limit_counters VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (level, target, meter, period, window) DO UPDATE SET
        used = used + excluded.used, reserved = reserved + excluded.reserved`,
      ...args,
      used,
      reserved,
    );
    if (used < 0 || reserved < 0)
      this.#sql.exec(
        `UPDATE limit_counters SET used = MAX(0, used), reserved = MAX(0, reserved)
          WHERE level = ? AND target = ? AND meter = ? AND period = ? AND window = ?`,
        ...args,
      );
  }

  /** The periods a scope counts a meter in: its limits' and, for totals, day, month and total. */
  #periods(scope: LimitScope, meter: string): Period[] {
    if (isGauge(meter)) return ["total"];
    const periods = new Set<Period>(["day", "month", "total"]);
    for (const l of scope.limits) if (l.meter === meter) periods.add(l.period);
    return [...periods];
  }

  #raised(key: string): number {
    const row = this.#sql.exec("SELECT amount FROM limit_raises WHERE key = ?", key).toArray()[0];
    return Number(row?.amount ?? 0);
  }

  /** The breaches a charge of `amounts` would make; empty when every limit holds. */
  breaches(scopes: readonly LimitScope[], amounts: Record<string, number>): LimitBreach[] {
    const now = this.#now();
    const found: LimitBreach[] = [];
    for (const scope of scopes)
      for (const limit of scope.limits) {
        const amount = amounts[limit.meter] ?? 0;
        if (!(amount > 0)) continue;
        const w = this.#window(limit.period, now);
        const ref = {
          level: scope.level,
          target: scope.target,
          meter: limit.meter,
          period: limit.period,
          window: w.start,
        };
        const key = keyOf(ref);
        const { used, reserved } = this.#counter(ref);
        const value = limit.value + this.#raised(key);
        if (used + reserved + amount <= value) continue;
        const verdict =
          limit.on_exceed === "ask" && ASK_LEVELS.includes(scope.level) ? "ask" : limit.on_exceed;
        found.push({
          limit,
          level: scope.level,
          target: scope.target,
          used: used + reserved,
          value,
          verdict,
          key,
          increment: limit.increment ?? (limit.value || 1),
          ...(Number.isFinite(w.reset) ? { retryAfterMs: Math.max(0, w.reset - now) } : {}),
        });
      }
    // A deny can't be approved away: it is said first, then a delay, then an ask.
    const rank = { deny: 0, delay: 1, ask: 2 };
    return found.sort((a, b) => rank[a.verdict] - rank[b.verdict]);
  }

  /** Each limit of each scope as it holds now: used, reserved, remaining and its reset. */
  states(scopes: readonly LimitScope[]): LimitState[] {
    const now = this.#now();
    const found: LimitState[] = [];
    for (const scope of scopes)
      for (const limit of scope.limits) {
        const w = this.#window(limit.period, now);
        const ref = {
          level: scope.level,
          target: scope.target,
          meter: limit.meter,
          period: limit.period,
          window: w.start,
        };
        const { used, reserved } = this.#counter(ref);
        const value = limit.value + this.#raised(keyOf(ref));
        found.push({
          meter: limit.meter,
          level: scope.level,
          target: scope.target,
          limit_level: limit.level,
          period: limit.period,
          on_exceed: limit.on_exceed,
          warn_at: limit.warn_at,
          value,
          used,
          reserved,
          remaining: Math.max(0, value - used - reserved),
          ...(Number.isFinite(w.reset) ? { reset: w.reset } : {}),
        });
      }
    return found;
  }

  /** Throws the first breach a charge would make (LimitExceeded). */
  check(scopes: readonly LimitScope[], amounts: Record<string, number>): void {
    const [first] = this.breaches(scopes, amounts);
    if (first) throw new LimitExceeded(first);
  }

  /**
   * Reserves `amounts` against every scope (the worst case of a request), refusing at the first
   * limit it would cross; `settle` then charges what was really used.
   */
  reserve(
    scopes: readonly LimitScope[],
    amounts: Record<string, number>,
    _meta?: UsageMeta,
  ): { id: string } {
    this.check(scopes, amounts);
    const now = this.#now();
    const entries: Entry[] = [];
    for (const scope of scopes)
      for (const [meter, amount] of Object.entries(amounts)) {
        if (!(amount > 0)) continue;
        for (const period of this.#periods(scope, meter)) {
          const e = {
            level: scope.level,
            target: scope.target,
            meter,
            period,
            window: this.#window(period, now).start,
            amount,
          };
          this.#bump(e, 0, amount);
          entries.push(e);
        }
      }
    const id = `rs-${crypto.randomUUID()}`;
    this.#sql.exec(
      "INSERT INTO limit_reservations VALUES (?, ?, ?, ?)",
      id,
      JSON.stringify(scopes),
      JSON.stringify(entries),
      now,
    );
    return { id };
  }

  /** Ends a reservation: what it held is released and `used` is charged (records, warnings). */
  settle(
    id: string,
    used: Record<string, number>,
    meta: UsageMeta,
    detail?: Record<string, unknown>,
  ): LimitWarning[] {
    const row = this.#sql
      .exec("SELECT scopes, entries FROM limit_reservations WHERE id = ?", id)
      .toArray()[0];
    if (!row) return [];
    this.#sql.exec("DELETE FROM limit_reservations WHERE id = ?", id);
    for (const e of JSON.parse(String(row.entries)) as Entry[]) this.#bump(e, 0, -e.amount);
    return this.#add(JSON.parse(String(row.scopes)) as LimitScope[], used, meta, detail);
  }

  /** Charges `amounts` against every scope at once, refusing at the first limit it would cross. */
  charge(
    scopes: readonly LimitScope[],
    amounts: Record<string, number>,
    meta: UsageMeta,
    detail?: Record<string, unknown>,
  ): LimitWarning[] {
    this.check(scopes, amounts);
    return this.#add(scopes, amounts, meta, detail);
  }

  /** Adds usage already spent (a response's bytes): recorded and counted, never refused. */
  add(
    scopes: readonly LimitScope[],
    amounts: Record<string, number>,
    meta: UsageMeta,
    detail?: Record<string, unknown>,
  ): LimitWarning[] {
    return this.#add(scopes, amounts, meta, detail);
  }

  /** Changes a gauge by `delta`: adding is refused over a limit, taking away always works. */
  adjust(
    scopes: readonly LimitScope[],
    meter: Meter,
    delta: number,
    meta: UsageMeta,
    detail?: Record<string, unknown>,
  ): LimitWarning[] {
    if (delta === 0) return [];
    if (delta > 0) this.check(scopes, { [meter]: delta });
    return this.#add(scopes, { [meter]: delta }, meta, detail);
  }

  #add(
    scopes: readonly LimitScope[],
    amounts: Record<string, number>,
    meta: UsageMeta,
    detail?: Record<string, unknown>,
  ): LimitWarning[] {
    const now = this.#now();
    this.#prune(now);
    const warnings: LimitWarning[] = [];
    for (const scope of scopes)
      for (const [meter, amount] of Object.entries(amounts)) {
        if (!amount) continue;
        for (const period of this.#periods(scope, meter))
          this.#bump(
            {
              level: scope.level,
              target: scope.target,
              meter,
              period,
              window: this.#window(period, now).start,
            },
            amount,
            0,
          );
        if (amount < 0) continue;
        for (const limit of scope.limits) {
          if (limit.meter !== meter) continue;
          const window = this.#window(limit.period, now).start;
          const ref = {
            level: scope.level,
            target: scope.target,
            meter,
            period: limit.period,
            window,
          };
          const key = keyOf(ref);
          const value = limit.value + this.#raised(key);
          const { used } = this.#counter(ref);
          if (used < limit.warn_at * value) continue;
          const warnKey = `${key}@${value}`;
          if (this.#sql.exec("SELECT 1 FROM limit_warned WHERE key = ?", warnKey).toArray().length)
            continue;
          this.#sql.exec("INSERT INTO limit_warned VALUES (?, ?)", warnKey, window);
          warnings.push({ limit, level: scope.level, target: scope.target, used, value });
        }
      }
    for (const [meter, amount] of Object.entries(amounts)) {
      if (!amount) continue;
      this.#sql.exec(
        `INSERT INTO usage_records (created, meter, amount, workspace, project, user, session, turn,
          detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        now,
        meter,
        amount,
        meta.workspace,
        meta.project,
        meta.user,
        meta.session ?? null,
        meta.turn ?? null,
        detail ? JSON.stringify(detail) : null,
      );
    }
    return warnings;
  }

  /** Raises the limit a breach named (its `key`) by `by`, for the rest of its window. */
  raise(key: string, by: number): void {
    let window = 0;
    try {
      window = Number((JSON.parse(key) as unknown[])[4]) || 0;
    } catch {
      return;
    }
    if (!(by > 0)) return;
    this.#sql.exec(
      `INSERT INTO limit_raises VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET
        amount = amount + excluded.amount`,
      key,
      by,
      window,
    );
  }

  /** What a scope used of a meter in the period's current window. */
  used(scope: { level: LimitLevel; target: string }, meter: string, period: Period): number {
    return this.#counter({ ...scope, meter, period, window: this.#window(period).start }).used;
  }

  /** What a scope holds reserved of a meter in the period's current window. */
  reserved(scope: { level: LimitLevel; target: string }, meter: string, period: Period): number {
    return this.#counter({ ...scope, meter, period, window: this.#window(period).start }).reserved;
  }

  /** Usage records after `since` (a seq), oldest first. */
  records(since = 0, limit = 1000): UsageRecord[] {
    return this.#sql
      .exec("SELECT * FROM usage_records WHERE seq > ? ORDER BY seq LIMIT ?", since, limit)
      .toArray()
      .map((r) => ({
        seq: Number(r.seq),
        created: Number(r.created),
        meter: String(r.meter) as Meter,
        amount: Number(r.amount),
        workspace: String(r.workspace),
        project: String(r.project),
        user: String(r.user),
        ...(r.session ? { session: String(r.session) } : {}),
        ...(r.turn ? { turn: String(r.turn) } : {}),
        ...(r.detail ? { detail: JSON.parse(String(r.detail)) } : {}),
      }));
  }

    /**
   * Usage between `from` and `until`, summed per project, user, session, model and meter in
   * quarter-hour buckets (every time zone's days start on one): the input of usage reports.
   */
  aggregate(filter: UsageFilter): UsageRow[] {
    const where = ["created >= ?", "created < ?"];
    const args: unknown[] = [filter.from, filter.until];
    for (const k of ["workspace", "project", "user"] as const)
      if (filter[k] !== undefined) {
        where.push(`${k} = ?`);
        args.push(filter[k]);
      }
    return this.#sql
      .exec(
        `SELECT project, user, session, json_extract(detail, '$.model') AS model, meter,
          (created / ${BUCKET_MS}) * ${BUCKET_MS} AS bucket, total(amount) AS amount
          FROM usage_records WHERE ${where.join(" AND ")}
          GROUP BY project, user, session, model, meter, bucket`,
        ...args,
      )
      .toArray()
      .map((r) => ({
        project: String(r.project),
        user: String(r.user),
        ...(r.session ? { session: String(r.session) } : {}),
        ...(r.model ? { model: String(r.model) } : {}),
        meter: String(r.meter),
        bucket: Number(r.bucket),
        amount: Number(r.amount),
      }));
  }

  /** Drops records, windows, raises and warnings older than the retention, at most once a day. */
  #prune(now: number): void {
    const last = Number(
      this.#sql.exec("SELECT value FROM limit_meta WHERE name = 'pruned'").toArray()[0]?.value ?? 0,
    );
    if (now - last < DAY) return;
    this.#sql.exec("INSERT OR REPLACE INTO limit_meta VALUES ('pruned', ?)", String(now));
    const cutoff = new Date(now);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - this.#retention);
    const t = cutoff.getTime();
    this.#sql.exec("DELETE FROM usage_records WHERE created < ?", t);
    this.#sql.exec("DELETE FROM limit_counters WHERE period != 'total' AND window < ?", t);
    this.#sql.exec("DELETE FROM limit_raises WHERE window != 0 AND window < ?", t);
    this.#sql.exec("DELETE FROM limit_warned WHERE window != 0 AND window < ?", t);
    // Reservations a crashed request never settled are released after a day.
    for (const r of this.#sql
      .exec("SELECT id FROM limit_reservations WHERE created < ?", now - DAY)
      .toArray())
      this.settle(String(r.id), {}, { workspace: "", project: "", user: "" });
  }
}

/**
 * Runs `charge`; a `delay` limit makes it wait for its window to reset when that is at most
 * `maxDelayMs` away (30 s), then tries once more. Otherwise a delay denies.
 */
export async function withDelay<T>(
  charge: () => T,
  options: { maxDelayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  try {
    return charge();
  } catch (e) {
    if (!(e instanceof LimitExceeded) || e.verdict !== "delay") throw e;
    const wait = e.breach.retryAfterMs;
    if (wait === undefined || wait > (options.maxDelayMs ?? 30_000)) throw e;
    await (options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(wait + 1);
    return charge();
  }
}
