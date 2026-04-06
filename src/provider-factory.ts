/**
 * Create Vercel AI SDK provider instances from provider name + apiKey.
 *
 * Delegates all actual HTTP/streaming to the Vercel AI SDK providers.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { ProviderV3 } from "@ai-sdk/provider";
import { type EmbeddingModel, generateText } from "ai";

export type ProviderName = "google" | "anthropic" | "openai";
export type { ProviderV3 };

export const PROVIDER_NAMES: ProviderName[] = ["google", "anthropic", "openai"];

/**
 * Create an AI SDK provider from a provider name and API key.
 */
export function createProvider(name: ProviderName, apiKey: string): ProviderV3 {
  switch (name) {
    case "google":
      return createGoogleGenerativeAI({ apiKey });
    case "anthropic":
      return createAnthropic({ apiKey });
    case "openai":
      return createOpenAI({ apiKey });
    default:
      throw new Error(`Unknown provider: ${name as string}`);
  }
}

/**
 * Verify that the provider + model combination works by making a minimal
 * generateText call. Throws on auth or network errors.
 */
export async function verifyModelAccess(
  provider: ProviderV3,
  model: string,
  signal?: AbortSignal,
): Promise<void> {
  await generateText({
    model: provider.languageModel(model),
    prompt: "hi",
    maxOutputTokens: 1,
    abortSignal: signal,
  });
}

/**
 * Create an embedding model using the provider-specific API.
 */
export function createEmbeddingModel(
  name: ProviderName,
  apiKey: string,
  modelId: string,
): EmbeddingModel {
  switch (name) {
    case "google": {
      const provider = createGoogleGenerativeAI({ apiKey });
      return provider.embeddingModel(modelId);
    }
    case "openai": {
      const provider = createOpenAI({ apiKey });
      return provider.embeddingModel(modelId);
    }
    case "anthropic":
      throw new Error("Anthropic does not support embedding models");
    default:
      throw new Error(`Unknown provider: ${name as string}`);
  }
}
