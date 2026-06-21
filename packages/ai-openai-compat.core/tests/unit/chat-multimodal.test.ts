import { describe, expect, it } from "vitest";
import { createOpenAICompat } from "../../src/index.js";
import { mockLanguageModel } from "./_helpers/mock-language-model.js";

const post = (body: unknown): Request =>
  new Request("http://x/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const userPromptParts = (model: ReturnType<typeof mockLanguageModel>) => {
  const userMsg = model.recordedCalls[0]?.prompt.find((m) => m.role === "user");
  expect(userMsg).toBeDefined();
  const content = userMsg?.content;
  expect(Array.isArray(content)).toBe(true);
  return content as unknown as Array<{ type: string; [k: string]: unknown }>;
};

describe("multimodal input", () => {
  it("text + image_url part translate to text + image (URL)", async () => {
    const model = mockLanguageModel({
      content: [{ type: "text", text: "ok" }],
    });
    const handler = createOpenAICompat({
      languageModels: { m: model },
    });
    const res = await handler(
      post({
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "caption" },
              {
                type: "image_url",
                image_url: { url: "https://example.com/y.png" },
              },
            ],
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const parts = userPromptParts(model);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: "text", text: "caption" });
    expect(parts[1]?.type).toBe("file");
    // V3 normalizes URL parts to file parts with mediaType image/*
    expect(String((parts[1] as unknown as { data: unknown }).data)).toBe(
      "https://example.com/y.png",
    );
    expect((parts[1] as unknown as { mediaType: string }).mediaType).toMatch(/^image\//);
  });

  it("file part with file_data translates to a file part", async () => {
    const model = mockLanguageModel({
      content: [{ type: "text", text: "ok" }],
    });
    const handler = createOpenAICompat({
      languageModels: { m: model },
    });
    await handler(
      post({
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "file",
                file: { file_data: "AQID", filename: "blob.bin" },
              },
            ],
          },
        ],
      }),
    );
    const parts = userPromptParts(model);
    expect(parts[0]?.type).toBe("file");
    expect((parts[0] as unknown as { data: string }).data).toContain("AQID");
  });

  it("input_audio mp3 maps to audio/mpeg, wav to audio/wav", async () => {
    const model1 = mockLanguageModel({
      content: [{ type: "text", text: "ok" }],
    });
    const handler1 = createOpenAICompat({
      languageModels: { m: model1 },
    });
    await handler1(
      post({
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "input_audio",
                input_audio: { data: "QUJD", format: "mp3" },
              },
            ],
          },
        ],
      }),
    );
    expect((userPromptParts(model1)[0] as unknown as { mediaType: string }).mediaType).toBe(
      "audio/mpeg",
    );

    const model2 = mockLanguageModel({
      content: [{ type: "text", text: "ok" }],
    });
    const handler2 = createOpenAICompat({
      languageModels: { m: model2 },
    });
    await handler2(
      post({
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "input_audio",
                input_audio: { data: "QUJD", format: "wav" },
              },
            ],
          },
        ],
      }),
    );
    expect((userPromptParts(model2)[0] as unknown as { mediaType: string }).mediaType).toBe(
      "audio/wav",
    );
  });
});
