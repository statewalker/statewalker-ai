import { describe, expect, it } from "vitest";
import { createOpenAICompat } from "../../src/index.js";
import { mockEmbeddingModel } from "./_helpers/mock-embedding-model.js";
import { mockLanguageModel } from "./_helpers/mock-language-model.js";

const get = (url: string): Request => new Request(url, { method: "GET" });

describe("GET /v1/models", () => {
  it("returns empty list when no models registered", async () => {
    const handler = createOpenAICompat({});
    const res = await handler(get("http://x/v1/models"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; data: unknown[] };
    expect(body).toEqual({ object: "list", data: [] });
  });

  it("returns union of language + embedding model ids", async () => {
    const handler = createOpenAICompat({
      languageModels: {
        a: mockLanguageModel(),
        b: mockLanguageModel(),
      },
      embeddingModels: { c: mockEmbeddingModel() },
    });
    const res = await handler(get("http://x/v1/models"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      data: Array<{
        id: string;
        object: string;
        created: number;
        owned_by: string;
      }>;
    };
    expect(body.object).toBe("list");
    const ids = body.data.map((d) => d.id).sort();
    expect(ids).toEqual(["a", "b", "c"]);
    for (const entry of body.data) {
      expect(entry.object).toBe("model");
      expect(entry.owned_by).toBe("openai-compat");
      expect(Number.isInteger(entry.created)).toBe(true);
    }
  });

  it("honors basePath", async () => {
    const handler = createOpenAICompat({
      basePath: "/api/openai",
      languageModels: { x: mockLanguageModel() },
    });
    const res = await handler(get("http://x/api/openai/models"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((d) => d.id)).toEqual(["x"]);
  });
});
