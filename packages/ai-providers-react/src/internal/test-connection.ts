import { verifyModelAccess } from "@statewalker/ai-agent/models";
import {
  type CanonicalProviderName,
  createRemoteProvider,
} from "@statewalker/ai-providers";

/**
 * Smallest model per canonical provider for cheap connection tests.
 */
const CANONICAL_SMOKE_MODELS: Record<CanonicalProviderName, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5-20251001",
  google: "gemini-2.5-flash",
};

export interface TestResult {
  ok: boolean;
  message: string;
}

export async function testCanonicalConnection(
  name: CanonicalProviderName,
  apiKey: string,
  signal?: AbortSignal,
): Promise<TestResult> {
  if (!apiKey) return { ok: false, message: "API key is required." };
  try {
    const provider = createRemoteProvider(name, apiKey);
    await verifyModelAccess(provider, CANONICAL_SMOKE_MODELS[name], signal);
    return { ok: true, message: `Connected to ${name}.` };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Smoke-test a custom OpenAI-compatible endpoint. We can't pre-pick a
 * model id (it's deployment-specific), so we issue a "models" list call
 * by trying a tiny generation against the conventional `gpt-4o-mini`
 * fallback — most OpenAI-compatible servers either accept it or surface
 * a helpful error listing the actual models. The user can use the result
 * to pick the right model id in the active-model picker.
 */
export async function testCustomConnection(
  apiKey: string,
  baseURL: string,
  signal?: AbortSignal,
): Promise<TestResult> {
  if (!apiKey) return { ok: false, message: "API key is required." };
  if (!baseURL) return { ok: false, message: "Base URL is required." };
  try {
    const provider = createRemoteProvider("openai-compatible", apiKey, baseURL);
    // Best-effort: the server may reject the model id but still validate
    // auth + reachability by responding with a structured error. Surface
    // whatever message it returns.
    await verifyModelAccess(provider, "gpt-4o-mini", signal);
    return { ok: true, message: "Endpoint reachable." };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
