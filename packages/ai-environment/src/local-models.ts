// The `local` model provider's engine (statewalker/statewalker-root#143, decision #105): a model
// running where the harness runs, in the user's own browser page, with no key. Whether a runtime
// has one is a capability its host declares by installing an engine before the deployment starts
// (`installLocalEngine`); the model gateway serves `local` models through it, and answers ENOSYS
// where none is installed. The engine never downloads weights for a request: a request runs only
// on a model whose weights `has` finds in the browser's cache, put there by the user's own action
// (an engine's `download`, called by the page, never by the harness).

/** A model engine in this runtime (WebLLM, transformers.js, a stand-in in tests). */
export interface LocalEngine {
  /** Whether a model's weights are cached here: requests run only on those. Never downloads. */
  has(model: string): Promise<boolean>;
  /**
   * An OpenAI-compatible chat-completions endpoint (`POST <any>/chat/completions`, the model
   * named in the body, streamed when the body asks), answered in this runtime. The gateway calls
   * it only for a model `has` found, with no key.
   */
  fetch(request: Request): Promise<Response>;
}

const KEY = Symbol.for("@statewalker/ai-environment/local-engine");
type Holder = { [KEY]?: LocalEngine };

/**
 * Declares this runtime's local model engine (a browser page's host calls it before it starts the
 * deployment); `undefined` withdraws it. It is held on the realm's global object, so a deployment
 * bundled with its own copy of this package finds it.
 */
export function installLocalEngine(engine: LocalEngine | undefined): void {
  const g = globalThis as Holder;
  if (engine) g[KEY] = engine;
  else delete g[KEY];
}

/** This runtime's local model engine, when its host installed one. */
export function localEngine(): LocalEngine | undefined {
  return (globalThis as Holder)[KEY];
}
