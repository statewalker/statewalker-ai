import { describe, expect, it } from "vitest";
import { isPattern, isSubject, subjectMatches } from "../src/index.js";

describe("subjects", () => {
  it("matches NATS-style wildcards: `*` one token, `>` one or more at the end", () => {
    expect(subjectMatches("orders.created", "orders.created")).toBe(true);
    expect(subjectMatches("orders.*", "orders.created")).toBe(true);
    expect(subjectMatches("orders.*", "orders.created.eu")).toBe(false);
    expect(subjectMatches("orders.>", "orders.created.eu")).toBe(true);
    expect(subjectMatches("orders.>", "orders")).toBe(false);
    expect(subjectMatches("*.created", "orders.created")).toBe(true);
    expect(subjectMatches(">", "a.b.c")).toBe(true);
  });

  it("keeps inboxes out of every filter but their own", () => {
    expect(subjectMatches(">", "_inbox.abc")).toBe(false);
    expect(subjectMatches("*.abc", "_inbox.abc")).toBe(false);
    expect(subjectMatches("_inbox.abc", "_inbox.abc")).toBe(true);
  });

  it("tells subjects from patterns", () => {
    expect(isSubject("orders.created")).toBe(true);
    expect(isSubject("orders.*")).toBe(false);
    expect(isSubject("orders..x")).toBe(false);
    expect(isSubject("has space")).toBe(false);
    expect(isSubject("")).toBe(false);
    expect(isPattern("orders.*")).toBe(true);
    expect(isPattern("orders.>")).toBe(true);
    expect(isPattern("orders.>.x")).toBe(false);
    expect(isPattern("orders.a*")).toBe(false);
  });
});
