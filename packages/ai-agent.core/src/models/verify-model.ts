import type { ProviderV3 } from "@ai-sdk/provider";
import { generateText } from "ai";

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
