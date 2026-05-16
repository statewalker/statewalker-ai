import { describe, expect, it } from "vitest";
import { capabilitiesFor } from "./capabilities.js";

describe("capabilitiesFor", () => {
  it("tags OpenAI embedding models as embedding", () => {
    expect(capabilitiesFor("text-embedding-3-small")).toEqual(["embedding"]);
    expect(capabilitiesFor("text-embedding-3-large")).toEqual(["embedding"]);
    expect(capabilitiesFor("text-embedding-ada-002")).toEqual(["embedding"]);
  });

  it("tags Voyage embedding models as embedding", () => {
    expect(capabilitiesFor("voyage-large-2-embed")).toEqual(["embedding"]);
  });

  it("tags Cohere embedding models as embedding", () => {
    expect(capabilitiesFor("embed-english-v3.0")).toEqual(["embedding"]);
  });

  it("tags DALL-E / Imagen as image", () => {
    expect(capabilitiesFor("dall-e-3")).toEqual(["image"]);
    expect(capabilitiesFor("imagen-3.0-generate")).toEqual(["image"]);
  });

  it("defaults unknown ids to text", () => {
    expect(capabilitiesFor("gpt-4o")).toEqual(["text"]);
    expect(capabilitiesFor("claude-sonnet-4-20250514")).toEqual(["text"]);
    expect(capabilitiesFor("some-random-model-id")).toEqual(["text"]);
  });
});
