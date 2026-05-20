import { describe, expect, it } from "vitest";
import { applyDefaultStarred, DEFAULT_STARRED_BY_TYPE } from "./default-starred.js";

describe("DEFAULT_STARRED_BY_TYPE", () => {
  it("has an entry for every ConnectionType", () => {
    expect(Object.keys(DEFAULT_STARRED_BY_TYPE).sort()).toEqual([
      "anthropic",
      "google",
      "openai",
      "openai-compatible",
    ]);
  });

  it("openai-compatible deliberately ships no defaults", () => {
    expect(DEFAULT_STARRED_BY_TYPE["openai-compatible"]).toEqual([]);
  });

  it("every glob is a non-empty string", () => {
    for (const [, globs] of Object.entries(DEFAULT_STARRED_BY_TYPE)) {
      for (const g of globs) {
        expect(typeof g).toBe("string");
        expect(g.length).toBeGreaterThan(0);
      }
    }
  });

  it("table is frozen", () => {
    expect(Object.isFrozen(DEFAULT_STARRED_BY_TYPE)).toBe(true);
    expect(Object.isFrozen(DEFAULT_STARRED_BY_TYPE.google)).toBe(true);
  });
});

describe("applyDefaultStarred", () => {
  it("matches Gemini variants for google", () => {
    const ids = [
      "gemini-1.5-pro",
      "gemini-1.5-flash",
      "gemini-2.0-flash-exp",
      "text-embedding-004",
      "imagen-3.0-generate",
    ];
    expect(applyDefaultStarred("google", ids)).toEqual([
      "gemini-1.5-pro",
      "gemini-1.5-flash",
      "gemini-2.0-flash-exp",
    ]);
  });

  it("matches gpt-4* family for openai", () => {
    const ids = [
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-4-turbo",
      "gpt-3.5-turbo",
      "text-embedding-3-small",
      "o1-mini",
    ];
    const result = applyDefaultStarred("openai", ids);
    expect(result).toContain("gpt-4o");
    expect(result).toContain("gpt-4o-mini");
    expect(result).toContain("gpt-4-turbo");
    expect(result).toContain("o1-mini");
    expect(result).not.toContain("gpt-3.5-turbo");
    expect(result).not.toContain("text-embedding-3-small");
  });

  it("matches Claude variants for anthropic", () => {
    const ids = [
      "claude-3-5-sonnet-20240620",
      "claude-3-opus-20240229",
      "claude-sonnet-4-20250514",
      "claude-2.1",
    ];
    const result = applyDefaultStarred("anthropic", ids);
    expect(result).toContain("claude-3-5-sonnet-20240620");
    expect(result).toContain("claude-3-opus-20240229");
    expect(result).toContain("claude-sonnet-4-20250514");
    expect(result).not.toContain("claude-2.1");
  });

  it("openai-compatible returns empty regardless of ids", () => {
    expect(applyDefaultStarred("openai-compatible", ["gpt-4o", "anything"])).toEqual([]);
  });

  it("preserves discovery order", () => {
    const ids = ["gpt-4o-mini", "gpt-4o", "gpt-4-turbo"];
    expect(applyDefaultStarred("openai", ids)).toEqual(["gpt-4o-mini", "gpt-4o", "gpt-4-turbo"]);
  });

  it("matching is case-insensitive", () => {
    expect(applyDefaultStarred("openai", ["GPT-4O"])).toEqual(["GPT-4O"]);
  });

  it("returns empty when no ids match", () => {
    expect(applyDefaultStarred("openai", ["claude-3-opus"])).toEqual([]);
  });
});
