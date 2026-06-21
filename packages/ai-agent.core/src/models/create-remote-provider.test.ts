import { describe, expect, it } from "vitest";
import { createRemoteProvider } from "./create-remote-provider.js";

describe("createRemoteProvider", () => {
  it("returns a ProviderV3 for anthropic", () => {
    const provider = createRemoteProvider("anthropic", { apiKey: "k" });
    expect(typeof provider.languageModel).toBe("function");
  });

  it("returns a ProviderV3 for google", () => {
    const provider = createRemoteProvider("google", { apiKey: "k" });
    expect(typeof provider.languageModel).toBe("function");
  });

  it("returns a ProviderV3 for openai", () => {
    const provider = createRemoteProvider("openai", { apiKey: "k" });
    expect(typeof provider.languageModel).toBe("function");
  });

  it("returns a ProviderV3 for openai-compatible with baseURL", () => {
    const provider = createRemoteProvider("openai-compatible", {
      apiKey: "k",
      baseURL: "https://example.test/v1",
    });
    expect(typeof provider.languageModel).toBe("function");
  });

  it("throws when openai-compatible lacks baseURL", () => {
    expect(() => createRemoteProvider("openai-compatible", { apiKey: "k" })).toThrow(/baseURL/);
  });

  it("throws on unknown provider name", () => {
    expect(() =>
      // @ts-expect-error: deliberately invalid for the test
      createRemoteProvider("nope", { apiKey: "k" }),
    ).toThrow(/Unknown provider/);
  });

  it("re-exports from the models barrel", async () => {
    const barrel = await import("./index.js");
    expect(barrel.createRemoteProvider).toBe(createRemoteProvider);
  });
});
