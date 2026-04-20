// biome-ignore lint/suspicious/noExplicitAny: @mlc-ai/web-llm has runtime-checked types and is loaded dynamically
type WebLLMModule = any;
// biome-ignore lint/suspicious/noExplicitAny: MLCEngine type varies across versions
type MLCEngine = any;

let _webllm: WebLLMModule | null = null;

/**
 * Lazy-load @mlc-ai/web-llm. Throws a clear error at activation time if the
 * dependency is missing — never at module-import time, so the package
 * remains safe to import from Node or from bundles that may or may not
 * have WebLLM installed.
 */
export async function getWebLLMModule(): Promise<WebLLMModule> {
  if (_webllm) return _webllm;
  try {
    _webllm = await import("@mlc-ai/web-llm");
  } catch (e) {
    throw new Error(
      "@mlc-ai/web-llm not installed. Install it with: pnpm add @mlc-ai/web-llm",
      { cause: e instanceof Error ? e : undefined },
    );
  }
  return _webllm;
}

export type { MLCEngine, WebLLMModule };
