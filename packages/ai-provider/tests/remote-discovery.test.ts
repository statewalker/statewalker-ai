import { afterEach, describe, expect, it, vi } from "vitest";
import { listModels } from "../src/remote-discovery.js";

interface FakeResponseInit {
  status?: number;
  ok?: boolean;
  json?: unknown;
  text?: string;
}

function fakeResponse(init: FakeResponseInit): Response {
  const status = init.status ?? 200;
  const ok = init.ok ?? (status >= 200 && status < 300);
  return {
    status,
    ok,
    async json() {
      return init.json;
    },
    async text() {
      return init.text ?? "";
    },
  } as unknown as Response;
}

describe("listModels", () => {
  afterEach(() => vi.restoreAllMocks());

  describe("anthropic", () => {
    it("hits /v1/models with x-api-key and parses data[]", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        fakeResponse({
          json: {
            data: [
              { id: "claude-sonnet-4-20250514", display_name: "Sonnet 4" },
              { id: "claude-haiku-4-5-20251001" },
            ],
          },
        }),
      );

      const result = await listModels("anthropic", { apiKey: "sk-ant-test" });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] ?? [];
      expect(url).toBe("https://api.anthropic.com/v1/models");
      expect(init).toMatchObject({
        method: "GET",
        headers: {
          "x-api-key": "sk-ant-test",
          "anthropic-version": expect.any(String),
        },
      });
      expect(result).toEqual([
        { id: "claude-sonnet-4-20250514", label: "Sonnet 4" },
        { id: "claude-haiku-4-5-20251001", label: "claude-haiku-4-5-20251001" },
      ]);
    });

    it("throws on missing apiKey", async () => {
      await expect(listModels("anthropic", {})).rejects.toThrow(/apiKey/);
    });
  });

  describe("openai", () => {
    it("hits /v1/models with Bearer auth and parses data[]", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        fakeResponse({
          json: { data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] },
        }),
      );

      const result = await listModels("openai", { apiKey: "sk-openai" });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] ?? [];
      expect(url).toBe("https://api.openai.com/v1/models");
      expect((init as RequestInit).headers).toMatchObject({
        Authorization: "Bearer sk-openai",
      });
      expect(result).toEqual([
        { id: "gpt-4o", label: "gpt-4o" },
        { id: "gpt-4o-mini", label: "gpt-4o-mini" },
      ]);
    });
  });

  describe("openai-compatible", () => {
    it("requires baseURL", async () => {
      await expect(listModels("openai-compatible", { apiKey: "key" })).rejects.toThrow(/baseURL/);
    });

    it("hits {baseURL}/models and omits Authorization when no apiKey", async () => {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(fakeResponse({ json: { data: [{ id: "local-7b" }] } }));

      const result = await listModels("openai-compatible", {
        baseURL: "http://localhost:1234/v1",
      });

      const [url, init] = fetchMock.mock.calls[0] ?? [];
      expect(url).toBe("http://localhost:1234/v1/models");
      expect((init as RequestInit).headers).toEqual({});
      expect(result).toEqual([{ id: "local-7b", label: "local-7b" }]);
    });

    it("strips trailing slash from baseURL", async () => {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(fakeResponse({ json: { data: [] } }));
      await listModels("openai-compatible", {
        apiKey: "k",
        baseURL: "https://api.groq.com/openai/v1/",
      });
      expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.groq.com/openai/v1/models");
    });
  });

  describe("google", () => {
    it("filters by supportedGenerationMethods and strips models/ prefix", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        fakeResponse({
          json: {
            models: [
              {
                name: "models/gemini-2.5-pro",
                displayName: "Gemini 2.5 Pro",
                supportedGenerationMethods: ["generateContent", "countTokens"],
              },
              {
                name: "models/embedding-001",
                displayName: "Embedding 001",
                supportedGenerationMethods: ["embedContent"],
              },
            ],
          },
        }),
      );

      const result = await listModels("google", { apiKey: "AIza-test" });

      const [url] = fetchMock.mock.calls[0] ?? [];
      expect(url).toMatch(/key=AIza-test$/);
      expect(result).toEqual([{ id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" }]);
    });
  });

  describe("error handling", () => {
    it("throws on non-OK with status and truncated body", async () => {
      const longBody = "x".repeat(2000);
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        fakeResponse({ status: 401, ok: false, text: longBody }),
      );
      await expect(listModels("openai", { apiKey: "bad" })).rejects.toThrow(/HTTP 401.*x{512}…/);
    });

    it("surfaces network failures", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
      await expect(listModels("openai", { apiKey: "k" })).rejects.toThrow("offline");
    });
  });
});
