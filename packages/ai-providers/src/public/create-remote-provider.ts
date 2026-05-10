import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { ProviderV3 } from "@ai-sdk/provider";
import type { ProviderName } from "@statewalker/ai-agent/models";

/** Build a `ProviderV3` for one of the supported remote providers. */
export function createRemoteProvider(
  name: ProviderName,
  apiKey: string,
  baseURL?: string,
): ProviderV3 {
  switch (name) {
    case "anthropic":
      return createAnthropic({ apiKey, baseURL });
    case "google":
      return createGoogleGenerativeAI({ apiKey, baseURL });
    case "openai":
      return createOpenAI({ apiKey, baseURL });
    case "openai-compatible":
      if (!baseURL) {
        throw new Error("openai-compatible provider requires a baseURL");
      }
      return createOpenAI({ apiKey, baseURL });
    default: {
      const _exhaustive: never = name;
      throw new Error(`Unknown provider: ${_exhaustive as string}`);
    }
  }
}
