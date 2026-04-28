import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { ModelManager as ModelManagerImpl } from "@statewalker/ai-provider";

// biome-ignore lint/suspicious/noExplicitAny: token constructors are heterogeneous
type AnyCtor = abstract new (...args: any[]) => unknown;

const guardAbstract = (target: AnyCtor | undefined, ctor: AnyCtor): void => {
  if (target === ctor) {
    throw new Error(`No adapter registered for ${ctor.name}`);
  }
};

/**
 * Token for the workspace-bound ModelManager. Concrete impl is the
 * ai-provider package's ModelManager, registered by initAiProviderCore.
 * Browser/node engine packages call workspace.requireAdapter(ModelManager)
 * to register their engines on .impl.
 */
export abstract class ModelManager {
  constructor() {
    guardAbstract(new.target, ModelManager);
  }
  abstract readonly impl: ModelManagerImpl;
}

/**
 * Token for per-provider settings persistence (API keys, baseURLs,
 * custom endpoints). Concrete impl is files-backed; future impls MAY
 * store credentials in a secrets store.
 */
export abstract class ProviderSettingsStore {
  constructor() {
    guardAbstract(new.target, ProviderSettingsStore);
  }
  abstract get(providerId: string): Promise<unknown | undefined>;
  abstract set(providerId: string, value: unknown): Promise<void>;
  abstract delete(providerId: string): Promise<boolean>;
  abstract list(): Promise<string[]>;
  abstract onUpdate(cb: (changedProviderIds: string[]) => void): () => void;
}

/**
 * Token for the active reasoning model — the one used for chat / tool
 * calls. Updated by `ai-provider:activate-model { role: "reasoning" }`.
 * Consumers call `ws.requireAdapter(ActiveReasoningModel).model` to get
 * the live LanguageModelV3 for direct use with the Vercel AI SDK.
 */
export abstract class ActiveReasoningModel {
  constructor() {
    guardAbstract(new.target, ActiveReasoningModel);
  }
  abstract readonly model: LanguageModelV3 | undefined;
  abstract readonly catalogKey: string | undefined;
  abstract onChange(cb: () => void): () => void;
}

/**
 * Token for the active embedding model. Independent of ActiveReasoningModel
 * — activating one role does not affect the other. Consumers retrieve the
 * live model the same way.
 */
export abstract class ActiveEmbeddingModel {
  constructor() {
    guardAbstract(new.target, ActiveEmbeddingModel);
  }
  abstract readonly model: LanguageModelV3 | undefined;
  abstract readonly catalogKey: string | undefined;
  abstract onChange(cb: () => void): () => void;
}
