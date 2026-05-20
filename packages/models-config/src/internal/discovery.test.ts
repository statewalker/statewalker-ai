import { type Connection, listConnectionModels } from "@statewalker/ai-providers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capabilitiesFor } from "./capabilities.js";

const originalFetch = globalThis.fetch;

function mockFetch(responder: (req: Request) => Response | Promise<Response>) {
  globalThis.fetch = vi.fn(async (input, init) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    return responder(req);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("listConnectionModels", () => {
  it("fetches OpenAI models and forwards headers", async () => {
    let seenAuth = "";
    let seenOrg = "";
    mockFetch((req) => {
      seenAuth = req.headers.get("Authorization") ?? "";
      seenOrg = req.headers.get("X-Org") ?? "";
      return new Response(
        JSON.stringify({
          data: [{ id: "gpt-4o" }, { id: "text-embedding-3-small" }],
        }),
        { status: 200 },
      );
    });
    const c: Connection = {
      id: "openai",
      type: "openai",
      name: "OpenAI",
      apiKey: "sk-test",
      headers: [{ name: "X-Org", value: "acme" }],
      starredModelIds: [],
    };
    const models = await listConnectionModels(c);
    expect(seenAuth).toBe("Bearer sk-test");
    expect(seenOrg).toBe("acme");
    expect(models).toHaveLength(2);
    expect(models[0]).toEqual({ id: "gpt-4o", label: "gpt-4o" });
  });

  it("fetches Anthropic models with anthropic-version header", async () => {
    let seenApiKey = "";
    let seenVersion = "";
    mockFetch((req) => {
      seenApiKey = req.headers.get("x-api-key") ?? "";
      seenVersion = req.headers.get("anthropic-version") ?? "";
      return new Response(
        JSON.stringify({
          data: [{ id: "claude-sonnet-4-20250514", display_name: "Claude Sonnet 4" }],
        }),
        { status: 200 },
      );
    });
    const c: Connection = {
      id: "anthropic",
      type: "anthropic",
      name: "Anthropic",
      apiKey: "sk-ant-test",
      starredModelIds: [],
    };
    const models = await listConnectionModels(c);
    expect(seenApiKey).toBe("sk-ant-test");
    expect(seenVersion).toBe("2023-06-01");
    expect(models[0]).toEqual({
      id: "claude-sonnet-4-20250514",
      label: "Claude Sonnet 4",
    });
  });

  it("filters Google models by generateContent support", async () => {
    mockFetch(() => {
      return new Response(
        JSON.stringify({
          models: [
            {
              name: "models/gemini-2.5-flash",
              displayName: "Gemini 2.5 Flash",
              supportedGenerationMethods: ["generateContent"],
            },
            {
              name: "models/text-embedding-004",
              displayName: "Text Embedding",
              supportedGenerationMethods: ["embedContent"],
            },
          ],
        }),
        { status: 200 },
      );
    });
    const c: Connection = {
      id: "google",
      type: "google",
      name: "Google",
      apiKey: "AIza-test",
      starredModelIds: [],
    };
    const models = await listConnectionModels(c);
    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe("gemini-2.5-flash");
  });

  it("requires url for openai-compatible", async () => {
    const c: Connection = {
      id: "lmstudio",
      type: "openai-compatible",
      name: "LM Studio",
      apiKey: "x",
      starredModelIds: [],
    };
    await expect(listConnectionModels(c)).rejects.toThrow(/url/i);
  });

  it("surfaces non-OK responses with status and truncated body", async () => {
    mockFetch(
      () =>
        new Response("Unauthorized: invalid api key", {
          status: 401,
          statusText: "Unauthorized",
        }),
    );
    const c: Connection = {
      id: "openai",
      type: "openai",
      name: "OpenAI",
      apiKey: "sk-bad",
      starredModelIds: [],
    };
    await expect(listConnectionModels(c)).rejects.toThrow(/401/);
  });
});

describe("capabilities tagging on discovery results", () => {
  it("derives capability tags from model ids", () => {
    const raw = [
      { id: "gpt-4o", label: "gpt-4o" },
      { id: "text-embedding-3-small", label: "text-embedding-3-small" },
    ];
    const tagged = raw.map((m) => ({ ...m, capabilities: capabilitiesFor(m.id) }));
    expect(tagged[0]?.capabilities).toEqual(["chat"]);
    expect(tagged[1]?.capabilities).toEqual(["embedding"]);
  });
});
