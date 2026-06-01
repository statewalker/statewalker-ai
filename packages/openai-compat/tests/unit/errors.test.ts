import { describe, expect, it } from "vitest";
import { createOpenAICompat } from "../../src/index.js";
import { mockEmbeddingModel } from "./_helpers/mock-embedding-model.js";
import { mockLanguageModel } from "./_helpers/mock-language-model.js";

const rawPost = (path: string, body: string): Request =>
  new Request(`http://x${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

const jsonPost = (path: string, body: unknown): Request => rawPost(path, JSON.stringify(body));

describe("error handling", () => {
  it("non-JSON body on chat completions → 400 invalid_request_error", async () => {
    const handler = createOpenAICompat({
      languageModels: { m: mockLanguageModel() },
    });
    const res = await handler(rawPost("/v1/chat/completions", "not-json"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request_error");
  });

  it("non-JSON body on completions → 400", async () => {
    const handler = createOpenAICompat({
      languageModels: { m: mockLanguageModel() },
    });
    const res = await handler(rawPost("/v1/completions", "not-json"));
    expect(res.status).toBe(400);
  });

  it("non-JSON body on embeddings → 400", async () => {
    const handler = createOpenAICompat({
      embeddingModels: { e: mockEmbeddingModel() },
    });
    const res = await handler(rawPost("/v1/embeddings", "not-json"));
    expect(res.status).toBe(400);
  });

  it("missing model field on chat completions → 400 with param 'model'", async () => {
    const handler = createOpenAICompat({
      languageModels: { m: mockLanguageModel() },
    });
    const res = await handler(
      jsonPost("/v1/chat/completions", {
        messages: [{ role: "user", content: "x" }],
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; param?: string };
    };
    expect(body.error.code).toBe("invalid_request_error");
    expect(body.error.param).toBe("model");
  });

  it("upstream model throw on chat completions → 500 upstream_error with message", async () => {
    const model = mockLanguageModel({
      throwOnGenerate: new Error("boom"),
    });
    const handler = createOpenAICompat({
      languageModels: { m: model },
    });
    const res = await handler(
      jsonPost("/v1/chat/completions", {
        model: "m",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("upstream_error");
    expect(body.error.message).toContain("boom");
    // No stack trace
    expect(JSON.stringify(body)).not.toContain("at ");
  });

  it("upstream model throw on completions → 500 upstream_error", async () => {
    const model = mockLanguageModel({
      throwOnGenerate: new Error("kaput"),
    });
    const handler = createOpenAICompat({
      languageModels: { m: model },
    });
    const res = await handler(jsonPost("/v1/completions", { model: "m", prompt: "hi" }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("upstream_error");
    expect(body.error.message).toContain("kaput");
  });

  it("upstream model throw on embeddings → 500 upstream_error", async () => {
    const model = mockEmbeddingModel({
      throwOnEmbed: new Error("nope"),
    });
    const handler = createOpenAICompat({
      embeddingModels: { e: model },
    });
    const res = await handler(jsonPost("/v1/embeddings", { model: "e", input: "hi" }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("upstream_error");
    expect(body.error.message).toContain("nope");
  });
});
