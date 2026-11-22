---
"@statewalker/ai-environment": minor
"@statewalker/ai-host-do": patch
---

The model gateway's `local` provider (statewalker/statewalker-root#143): a runtime declares a local
model engine with `installLocalEngine` (`@statewalker/ai-environment/local-models`), and `local`
models run on it with no key, only once the user has downloaded their weights; elsewhere they answer
`ENOSYS` and, like a model without weights, fall back to the agent's next model.
`@statewalker/ai-environment/webllm` is the WebLLM engine, ported from `ai-local-models.browser`.
The Workspace DO serves `local` models through the runtime's engine.
