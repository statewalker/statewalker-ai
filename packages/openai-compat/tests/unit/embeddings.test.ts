import { describe, expect, it } from "vitest";
import { createOpenAICompat } from "../../src/index.js";
import { mockEmbeddingModel } from "./_helpers/mock-embedding-model.js";

const post = (body: unknown): Request =>
  new Request("http://x/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

interface EmbeddingsResponse {
  object: string;
  data: Array<{
    object: string;
    embedding: number[];
    index: number;
  }>;
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

describe("POST /v1/embeddings", () => {
  it("single string input returns one vector with index 0", async () => {
    const model = mockEmbeddingModel({
      embeddings: [[0.1, 0.2, 0.3]],
      tokens: 7,
    });
    const handler = createOpenAICompat({
      embeddingModels: { e: model },
    });
    const res = await handler(post({ model: "e", input: "hi" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as EmbeddingsResponse;
    expect(body.object).toBe("list");
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.object).toBe("embedding");
    expect(body.data[0]?.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(body.data[0]?.index).toBe(0);
    expect(body.model).toBe("e");
    expect(body.usage.total_tokens).toBe(7);
    expect(body.usage.prompt_tokens).toBe(7);
  });

  it("string-array input preserves input order", async () => {
    const model = mockEmbeddingModel({
      embeddings: [
        [1, 0, 0],
        [0, 1, 0],
      ],
      tokens: 4,
    });
    const handler = createOpenAICompat({
      embeddingModels: { e: model },
    });
    const res = await handler(post({ model: "e", input: ["a", "b"] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as EmbeddingsResponse;
    expect(body.data).toHaveLength(2);
    expect(body.data[0]?.index).toBe(0);
    expect(body.data[1]?.index).toBe(1);
    expect(body.data[0]?.embedding).toEqual([1, 0, 0]);
    expect(body.data[1]?.embedding).toEqual([0, 1, 0]);
  });

  it("number-array input is rejected", async () => {
    const handler = createOpenAICompat({
      embeddingModels: { e: mockEmbeddingModel() },
    });
    const res = await handler(post({ model: "e", input: [1, 2, 3] }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request_error");
  });

  it("404s on unknown model", async () => {
    const handler = createOpenAICompat({
      embeddingModels: { e: mockEmbeddingModel() },
    });
    const res = await handler(post({ model: "unknown", input: "x" }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("model_not_found");
  });
});
