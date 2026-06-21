import { describe, expect, it } from "vitest";
import {
  formatModelReference,
  isValidConnectionId,
  parseModelReference,
} from "./model-reference.js";

describe("model-reference", () => {
  it("splits on the first colon, keeping a namespaced model id intact", () => {
    expect(parseModelReference("proxyA:openai/gpt-4.1")).toEqual({
      connectionId: "proxyA",
      modelId: "openai/gpt-4.1",
    });
  });

  it("parses the simple seeded case", () => {
    expect(parseModelReference("openai:gpt-4.1")).toEqual({
      connectionId: "openai",
      modelId: "gpt-4.1",
    });
  });

  it("keeps a further colon inside the model id", () => {
    expect(parseModelReference("local:llama3:8b")).toEqual({
      connectionId: "local",
      modelId: "llama3:8b",
    });
  });

  it("throws when there is no separator", () => {
    expect(() => parseModelReference("gpt-4.1")).toThrow();
  });

  it("formats and round-trips", () => {
    expect(parseModelReference(formatModelReference("google", "gemini-2.0"))).toEqual({
      connectionId: "google",
      modelId: "gemini-2.0",
    });
  });

  it("rejects a connection id containing the separator", () => {
    expect(isValidConnectionId("a:b")).toBe(false);
    expect(() => formatModelReference("a:b", "m")).toThrow();
  });
});
