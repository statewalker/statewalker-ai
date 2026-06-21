import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { ProviderV3 } from "@ai-sdk/provider";
import type { ProviderName, RemoteProviderSettings } from "./types.js";

export function createRemoteProvider(
  providerName: ProviderName,
  settings: RemoteProviderSettings,
): ProviderV3 {
  switch (providerName) {
    case "anthropic":
      return createAnthropic(settings);
    case "google":
      return createGoogleGenerativeAI(settings);
    case "openai":
      return createOpenAI(settings);
    case "openai-compatible":
      if (!settings.baseURL) {
        throw new Error("openai-compatible provider requires settings.baseURL");
      }
      return createOpenAI(settings);
    default:
      throw new Error(`Unknown provider: ${providerName as string}`);
  }
}
