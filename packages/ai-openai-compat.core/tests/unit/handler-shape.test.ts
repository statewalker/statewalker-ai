import { describe, expect, it } from "vitest";
import { createOpenAICompat } from "../../src/index.js";

describe("handler shape & basePath", () => {
  it("createOpenAICompat returns a function", () => {
    const handler = createOpenAICompat({});
    expect(typeof handler).toBe("function");
  });

  it("returns 404 + OpenAI error envelope on unmatched paths under default /v1", async () => {
    const handler = createOpenAICompat({});
    const res = await handler(new Request("http://x/v1/something-unknown"));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = (await res.json()) as {
      error: { type: string; code: string; message: string };
    };
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("returns 404 when the prefix doesn't match the base path at all", async () => {
    const handler = createOpenAICompat({});
    const res = await handler(new Request("http://x/v2/models"));
    expect(res.status).toBe(404);
  });

  it("honors a custom basePath", async () => {
    const handler = createOpenAICompat({ basePath: "/api/openai" });
    const res = await handler(new Request("http://x/api/openai/something-unknown"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { type: string; code: string };
    };
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("does not match default /v1 when basePath is overridden", async () => {
    const handler = createOpenAICompat({ basePath: "/api/openai" });
    const res = await handler(new Request("http://x/v1/models"));
    expect(res.status).toBe(404);
  });
});
