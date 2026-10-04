import type { ModelProvider } from "./types.js";
import { generateText } from "ai";

/**
 * Verify that the provider + model combination works by making a minimal
 * generateText call. Throws on auth or network errors.
 */
export async function verifyModelAccess(
  provider: ModelProvider,
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
