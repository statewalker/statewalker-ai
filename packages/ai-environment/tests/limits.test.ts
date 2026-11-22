// Meters, limits and usage records (statewalker/statewalker-root#179, decision #158): the ledger
// each owning Durable Object keeps (Agent DO, Workspace DO, User DO). What the session API can't
// show at its seam is checked here: calendar windows in the deployment's time zone, reservations
// under concurrency, and retention.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  LimitExceeded,
  LimitLedger,
  type LimitScope,
  parseLimits,
  type SqlLike,
  windowOf,
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

const META = { workspace: "w", project: "p", user: "u", session: "s", turn: "s.tu-1" };

describe("limits", () => {
  it("reads limits leniently: what is not a limit is reported and left out", () => {
    const { limits, problems } = parseLimits(
      JSON.stringify([
        { meter: "tool_calls", level: "workspace", value: 10, period: "day", on_exceed: "deny" },
        { meter: "model_spend", level: "session", value: 2.5, period: "total" },
        { meter: "executor_cpu_ms:node", level: "project", value: 1000, period: "hour" },
        { meter: "tool_calls", level: "workspace", value: 5, period: "day", on_exceed: "ask" },
        { meter: "nothing", level: "workspace", value: 1, period: "day" },
        { meter: "turns", level: "galaxy", value: 1, period: "day" },
        { meter: "turns", level: "member", value: -1, period: "day" },
        { meter: "storage_bytes", level: "project", value: 10, period: "day" },
      ]),
    );
    expect(limits).toEqual([
      {
        meter: "tool_calls",
        level: "workspace",
        value: 10,
        period: "day",
        on_exceed: "deny",
        warn_at: 0.8,
      },
      {
        meter: "model_spend",
        level: "session",
        value: 2.5,
        period: "total",
        on_exceed: "deny",
        warn_at: 0.8,
      },
      {
        meter: "executor_cpu_ms:node",
        level: "project",
        value: 1000,
        period: "hour",
        on_exceed: "deny",
        warn_at: 0.8,
      },
      // Only session and user levels ask: a workspace's ask denies.
      {
        meter: "tool_calls",
        level: "workspace",
        value: 5,
        period: "day",
        on_exceed: "deny",
        warn_at: 0.8,
      },
      // A gauge (what is held now) has no period but its total.
      {
        meter: "storage_bytes",
        level: "project",
        value: 10,
        period: "total",
        on_exceed: "deny",
        warn_at: 0.8,
      },
    ]);
    expect(problems).toHaveLength(5);
    expect(parseLimits("nope").problems).toHaveLength(1);
    expect(parseLimits(undefined)).toEqual({ limits: [], problems: [] });
  });

  it("starts calendar windows in the deployment's time zone", () => {
    // 2026-03-01 02:30 in Tokyo is still February in UTC.
    const now = Date.UTC(2026, 1, 28, 17, 30);
    expect(windowOf("month", now, "UTC")).toEqual({
      start: Date.UTC(2026, 1, 1),
      reset: Date.UTC(2026, 2, 1),
    });
    expect(windowOf("month", now, "Asia/Tokyo")).toEqual({
      start: Date.UTC(2026, 1, 28, 15),
      reset: Date.UTC(2026, 2, 31, 15),
    });
    expect(windowOf("day", now, "Asia/Tokyo")).toEqual({
      start: Date.UTC(2026, 1, 28, 15),
      reset: Date.UTC(2026, 2, 1, 15),
    });
    expect(windowOf("minute", now + 12_345, "UTC")).toEqual({
      start: now,
      reset: now + 60_000,
    });
    expect(windowOf("total", now, "UTC")).toEqual({ start: 0, reset: Number.POSITIVE_INFINITY });
  });

  it("charges every scope on the path and refuses at the tightest limit", () => {
    const ledger = new LimitLedger(sqlite());
    const scopes: LimitScope[] = [
      {
        level: "workspace",
        target: "w",
        limits: parseLimits('[{"meter":"tool_calls","level":"workspace","value":5,"period":"day"}]')
          .limits,
      },
      {
        level: "member",
        target: "u",
        limits: parseLimits('[{"meter":"tool_calls","level":"member","value":2,"period":"day"}]')
          .limits,
      },
    ];
    ledger.charge(scopes, { tool_calls: 1 }, META);
    ledger.charge(scopes, { tool_calls: 1 }, META);
    let refused: unknown;
    try {
      ledger.charge(scopes, { tool_calls: 1 }, META);
    } catch (e) {
      refused = e;
    }
    expect(refused).toBeInstanceOf(LimitExceeded);
    expect((refused as LimitExceeded).limit).toMatchObject({ level: "member", value: 2 });
    expect(String((refused as Error).message)).toMatch(/^ELIMIT: /);
    // Another member is held by the workspace's limit only.
    const other: LimitScope[] = [
      scopes[0] as LimitScope,
      { level: "member", target: "v", limits: [] },
    ];
    ledger.charge(other, { tool_calls: 3 }, META);
    expect(() => ledger.charge(other, { tool_calls: 1 }, META)).toThrow(/workspace/);
    expect(ledger.used({ level: "workspace", target: "w" }, "tool_calls", "day")).toBe(5);
    expect(ledger.used({ level: "member", target: "u" }, "tool_calls", "day")).toBe(2);
  });

  it("reserves the worst case, so parallel requests never overshoot, then settles to the real cost", () => {
    const ledger = new LimitLedger(sqlite());
    const scopes: LimitScope[] = [
      {
        level: "workspace",
        target: "w",
        limits: parseLimits(
          '[{"meter":"model_spend","level":"workspace","value":10,"period":"month"}]',
        ).limits,
      },
    ];
    const a = ledger.reserve(scopes, { model_spend: 4 }, META);
    const b = ledger.reserve(scopes, { model_spend: 4 }, META);
    expect(() => ledger.reserve(scopes, { model_spend: 4 }, META)).toThrow(LimitExceeded);
    ledger.settle(a.id, { model_spend: 1, model_tokens: 100 }, META);
    ledger.settle(b.id, { model_spend: 1 }, META);
    expect(ledger.used({ level: "workspace", target: "w" }, "model_spend", "month")).toBe(2);
    expect(ledger.reserved({ level: "workspace", target: "w" }, "model_spend", "month")).toBe(0);
    ledger.reserve(scopes, { model_spend: 8 }, META);
    // Every settled charge is a usage record naming its workspace, project, user, session, turn.
    expect(ledger.records().map((r) => [r.meter, r.amount])).toEqual([
      ["model_spend", 1],
      ["model_tokens", 100],
      ["model_spend", 1],
    ]);
    expect(ledger.records()[0]).toMatchObject(META);
  });

  it("warns once per window when usage crosses warn_at", () => {
    const ledger = new LimitLedger(sqlite());
    const scopes: LimitScope[] = [
      {
        level: "session",
        target: "s",
        limits: parseLimits(
          '[{"meter":"turns","level":"session","value":10,"period":"total","warn_at":0.5}]',
        ).limits,
      },
    ];
    const warnings = [1, 2, 3, 4, 5, 6].map(() => ledger.charge(scopes, { turns: 1 }, META).length);
    expect(warnings).toEqual([0, 0, 0, 0, 1, 0]);
  });

  it("asks only at session and user levels, and an approval raises the limit by one increment", () => {
    const ledger = new LimitLedger(sqlite());
    const limits = parseLimits(
      '[{"meter":"tool_calls","level":"session","value":1,"period":"total","on_exceed":"ask","increment":2}]',
    ).limits;
    const scopes: LimitScope[] = [{ level: "session", target: "s", limits }];
    ledger.charge(scopes, { tool_calls: 1 }, META);
    let asked: LimitExceeded | undefined;
    try {
      ledger.charge(scopes, { tool_calls: 1 }, META);
    } catch (e) {
      asked = e as LimitExceeded;
    }
    expect(asked?.verdict).toBe("ask");
    ledger.raise(asked?.key as string, asked?.increment as number);
    ledger.charge(scopes, { tool_calls: 2 }, META);
    expect(() => ledger.charge(scopes, { tool_calls: 1 }, META)).toThrow(LimitExceeded);
  });

  it("holds gauges as what is held now: adding over the limit fails, taking away always works", () => {
    const ledger = new LimitLedger(sqlite());
    const scopes: LimitScope[] = [
      {
        level: "project",
        target: "p",
        limits: parseLimits('[{"meter":"storage_bytes","level":"project","value":100}]').limits,
      },
    ];
    ledger.adjust(scopes, "storage_bytes", 90, META);
    expect(() => ledger.adjust(scopes, "storage_bytes", 20, META)).toThrow(LimitExceeded);
    ledger.adjust(scopes, "storage_bytes", -50, META);
    ledger.adjust(scopes, "storage_bytes", 50, META);
    expect(ledger.used({ level: "project", target: "p" }, "storage_bytes", "total")).toBe(90);
  });

  it("keeps per-period totals beside the records and drops records past the retention", () => {
    let now = Date.UTC(2025, 0, 15);
    const ledger = new LimitLedger(sqlite(), { retentionMonths: 13, now: () => now });
    const scopes: LimitScope[] = [{ level: "workspace", target: "w", limits: [] }];
    ledger.charge(scopes, { turns: 1 }, META);
    expect(ledger.used({ level: "workspace", target: "w" }, "turns", "month")).toBe(1);
    expect(ledger.used({ level: "workspace", target: "w" }, "turns", "day")).toBe(1);
    now = Date.UTC(2026, 2, 1);
    ledger.charge(scopes, { turns: 1 }, META);
    expect(ledger.records().map((r) => r.created)).toEqual([Date.UTC(2026, 2, 1)]);
    expect(ledger.used({ level: "workspace", target: "w" }, "turns", "month")).toBe(1);
    expect(ledger.used({ level: "workspace", target: "w" }, "turns", "total")).toBe(2);
  });
});
