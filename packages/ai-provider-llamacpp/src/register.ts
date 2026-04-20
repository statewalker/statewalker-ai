import type { LanguageModelV3 } from "@ai-sdk/provider";
import type {
  ActivationProgress,
  LocalModelConfig,
  ModelManager,
} from "@statewalker/ai-provider";
import type { FilesApi } from "@statewalker/webrun-files";
import { resolveGgufFiles, verifyGgufWeights } from "./gguf-resolver.js";
import { LlamaCppLanguageModel } from "./llamacpp-language-model.js";
import { getLlamaCppModule } from "./llamacpp-loader.js";

export interface LlamaCppRegistrationOptions {
  /**
   * Real filesystem directory that maps to the FilesApi virtual root.
   * Required: `node-llama-cpp` memory-maps GGUF files and needs an
   * on-disk path, so we must know where FilesApi virtual paths resolve.
   * In the CLI, pass the same `rootDir` that was given to `NodeFilesApi`.
   */
  rootDir: string;
  /**
   * Root virtual path under which `LocalModelStorage` writes llama.cpp
   * weights. Defaults to `/models/llamacpp` to match `ModelManager`'s
   * default storage path + the engine namespace.
   */
  virtualBasePath?: string;
}

/**
 * Register llama.cpp as the `"llamacpp"` engine on the given
 * `ModelManager`. Installs the GGUF file resolver, a GGUF presence
 * verifier, and a factory that opens a `LlamaModel` via
 * `node-llama-cpp` and returns a `LlamaCppLanguageModel`.
 */
export function registerLlamaCppProvider(
  manager: ModelManager,
  options: LlamaCppRegistrationOptions,
): void {
  const virtualBase = options.virtualBasePath ?? "/models/llamacpp";

  manager.registerLocalFactory("llamacpp", {
    fileResolver: resolveGgufFiles,
    verifier: verifyGgufWeights,
    factory: async (
      modelId: string,
      config: LocalModelConfig,
      _files: FilesApi,
      onProgress: (progress: ActivationProgress) => void,
      signal?: AbortSignal,
    ): Promise<LanguageModelV3> => {
      if (!config.ggufFile) {
        throw new Error(
          `llama.cpp model "${modelId}" is missing required \`ggufFile\` field in its catalog entry.`,
        );
      }

      onProgress({
        modelKey: modelId,
        phase: "loading",
        progress: 0,
        message: "Loading GGUF file into llama.cpp…",
      });

      const { getLlama, LlamaChatSession } = await getLlamaCppModule();
      signal?.throwIfAborted();

      // FilesApi wrote weights under virtualBase/{modelId}/{ggufFile};
      // translate that to a real on-disk path for llama.cpp's mmap path.
      const virtualPath = `${virtualBase}/${modelId}/${config.ggufFile}`;
      const modelPath = `${options.rootDir}${virtualPath}`;

      const llama = await getLlama();
      signal?.throwIfAborted();
      const model = await llama.loadModel({ modelPath });
      signal?.throwIfAborted();
      const context = await model.createContext({
        contextSize: config.ggufNCtx ?? 4096,
      });

      onProgress({
        modelKey: modelId,
        phase: "ready",
        progress: 1,
        message: `${config.label} ready`,
      });

      let disposed = false;
      const dispose = async () => {
        if (disposed) return;
        disposed = true;
        try {
          await context.dispose?.();
        } finally {
          await model.dispose?.();
        }
      };

      return new LlamaCppLanguageModel(
        modelId,
        ({ systemPrompt }) =>
          new LlamaChatSession({
            contextSequence: context.getSequence(),
            systemPrompt,
          }),
        dispose,
      );
    },
  });
}
