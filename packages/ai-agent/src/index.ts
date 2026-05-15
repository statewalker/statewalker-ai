// `@statewalker/ai-agent` (root) — intentionally minimal.
//
// Use the dedicated sub-paths:
//   - `@statewalker/ai-agent/runtime`   → AgentRuntime, Agent, Session
//   - `@statewalker/ai-agent/state`     → SessionState, Turn, Message, ToolCall, …
//   - `@statewalker/ai-agent/models`    → ModelManager, ModelStateStore, …
//   - `@statewalker/ai-agent/tools`     → createFileTools, path utilities
//
// Internal modules (`controller` removed in #2; `context`, `mcp`, `skills`,
// `config`, `sessions`) are no longer reachable from the root. They live as
// implementation detail; reach them only via deep imports if absolutely
// necessary, with the understanding that they are not part of the public API.
export {};
