// Public surface of `@statewalker/ai-agent/state`.
//
// Each export is a deliberate decision: it appears on this list because at
// least one external consumer (or one runtime-internal test) imports it
// through the published sub-path. Internal modules import directly from the
// source files (deep paths) — they never depend on this barrel.
//
// To add a new symbol to the public surface: add an explicit `export ...`
// line below. To remove one: confirm via grep that no consumer imports it.

// ── Per-Session collections ─────────────────────────────────────────────
export { Inbox, type InboxMessage } from "./inbox.js";
export type { LogMessage, TurnFinishKind } from "./log-message.js";
export { Message } from "./message.js";
// ── Factory + tree types used externally ────────────────────────────────
export { createAgentNodeFactory } from "./node-factory.js";
export { NodeType } from "./node-types.js";
// ── Conversation state — the persisted tree ─────────────────────────────
export { SessionState } from "./session-state.js";
export { SkillsModel } from "./skills-model.js";
export { ToolCall } from "./tool-call.js";
export { ToolRegistry } from "./tool-registry.js";
// ── Tree primitives + node-type registry ────────────────────────────────
export { TreeNode } from "./tree-node.js";
export type { NodeFactory, TreeEntry } from "./tree-types.js";
export { type StreamPart, Turn, type Usage } from "./turn.js";
export { type SummarySection, TurnGroup } from "./turn-group.js";
