import { describe, expect, it } from "vitest";
import { buildProvider } from "./provider-build.js";

describe("buildProvider", () => {
  it("builds a ProviderV3 for each canonical provider type", () => {
    for (const type of ["openai", "anthropic", "google"] as const) {
      const provider = buildProvider(type, { apiKey: "sk-test" });
      expect(typeof provider.languageModel).toBe("function");
    }
  });

  it("builds an openai-compatible provider when a baseURL is given", () => {
    const provider = buildProvider("openai-compatible", {
      apiKey: "sk-test",
      baseURL: "https://proxy.example/v1",
    });
    expect(typeof provider.languageModel).toBe("function");
  });

  it("rejects openai-compatible without a baseURL (the endpoint is the config)", () => {
    expect(() => buildProvider("openai-compatible", { apiKey: "sk-test" })).toThrow(/baseURL/);
  });

  it("forwards custom headers as a header record", () => {
    // Smoke: header-carrying build must not throw.
    const provider = buildProvider("openai", {
      apiKey: "sk-test",
      headers: [{ name: "X-Org", value: "acme" }],
    });
    expect(typeof provider.languageModel).toBe("function");
  });
});
