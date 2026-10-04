import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { ModelProvider } from "./types.js";
import type { ProviderName, RemoteProviderSettings } from "./types.js";

export function createRemoteProvider(
  providerName: ProviderName,
  settings: RemoteProviderSettings,
): ModelProvider {
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
