import initAiProviderCore from "./composition/ai-provider-core.js";

export * from "./api/intents.js";
export { ModelManager } from "./composition/adapters.js";
export {
  detectAvailableEngines,
  type EngineAvailability,
  resetEngineDetectionCache,
} from "./core/engine-detection.js";
export * from "./core/legacy-adapters.js";
export { initAiProviderCore };
export default initAiProviderCore;
