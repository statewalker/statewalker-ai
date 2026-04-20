import type { LocalModelConfig } from "@statewalker/ai-provider";

/**
 * llama.cpp file resolver: single GGUF file located at `config.ggufFile`
 * in the HuggingFace repo. Size is taken from `config.sizeBytes` (HEAD
 * would work too but adds a network round-trip per activation).
 */
export async function resolveGgufFiles(
  _modelId: string,
  config: LocalModelConfig,
  _signal?: AbortSignal,
): Promise<Array<{ name: string; size: number }>> {
  if (!config.ggufFile) {
    throw new Error(
      "llama.cpp model config is missing required `ggufFile` field",
    );
  }
  return [{ name: config.ggufFile, size: config.sizeBytes }];
}

/**
 * Predicate for `LocalModelStorage.hasWeights` — the metadata file plus
 * a single `.gguf` file indicates a complete download.
 */
export async function verifyGgufWeights(
  entries: AsyncIterable<{ kind: string; name: string }>,
): Promise<boolean> {
  for await (const entry of entries) {
    if (entry.kind === "file" && entry.name.endsWith(".gguf")) return true;
  }
  return false;
}
