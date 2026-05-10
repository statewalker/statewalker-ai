// All browser-engine providers (transformers.js + WebLLM) are temporarily
// disabled at the package entrypoint. With nothing exported, consumers
// that don't import from sub-paths will tree-shake @huggingface/transformers,
// @browser-ai/transformers-js, @mlc-ai/web-llm, and onnxruntime-web out of
// their bundle entirely. Re-enable individual exports when needed.

// export { registerBrowserProviders } from "./register.js";
// export { registerLocalProvider as registerTransformersProvider } from "./transformers/register.js";
// export { webllmCatalog } from "./webllm/catalog.js";
// export { registerWebLLMProvider } from "./webllm/register.js";
// export {
//   propagateFilesHandle,
//   registerWebLLMUrlMapping,
//   unregisterWebLLMUrlMapping,
// } from "./webllm/sw-bridge.js";
export {};
