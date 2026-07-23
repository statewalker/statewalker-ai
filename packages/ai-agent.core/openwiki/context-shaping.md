# Context Shaping

How the runtime produces `{ system, messages, events, stats }` for each model call — running compaction, selection, elision, pin policy, and system-prompt assembly behind one interface.

## ContextWindow

One `ContextWindow` is constructed per `Session` and reused across every turn. `build(state, { skills })` returns the inputs for the next `streamText` call.

```ts
class ContextWindow {
  constructor(options: ContextWindowOptions);
  async build(state: SessionState, opts: { skills: SkillsModel }): Promise<ContextWindowResult>;
}

interface ContextWindowResult {
  system: string;               // system prompt for the upcoming streamText call
  messages: ModelMessage[];    // projected messages to send to the model
  events: LogMessage[];        // events produced during build (e.g. context-thrash)
  stats: { messageCount: number; estimatedTokens: number; compacted: boolean };
}
```

### Construction options

| Option | Default | Purpose |
|---|---|---|
| `provider` | (required) | `ProviderV3` — used by callers, not internally by `build`. |
| `model` | (required) | Model id — used by callers via `provider.languageModel(model)`. |
| `selectStrategy` | `selectAll` | Projection from tree to `ModelMessage[]`. |
| `systemPromptTemplate` | `DEFAULT_SYSTEM_PROMPT` | Base system prompt; per-agent overrides threaded in by runtime. |
| `estimator` | `createTokenEstimator()` | Token count estimation. |
| `pinPolicy` | no-pin policy | Decides which nodes are protected from compaction. |
| `elisionPolicy` | `createDefaultElisionPolicy()` | Shortens tool-call results in projection. |
| `summarizer` | (none) | Required to enable budget compaction. |
| `budgetTokens` | (none) | Token budget for hierarchical compaction. |
| `keepRecentTurns` | 4 | Turns kept ungrouped at the tail. |
| `groupSize` | 6 | Turns per depth-1 group. |
| `depthPromoteThreshold` | 4 | Same-depth groups before depth promotion. |
| `maxPassesPerCompact` | 8 | Max compaction passes before `context-thrash`. |

### Contract: tree mutation

When budget compaction is configured, `build()` adopts older turns under `TurnGroup` wrappers, and those wrappers persist into the saved session. Callers MUST NOT invoke `build()` concurrently against the same `state` — the agent loop is serial per session and this invariant is the caller's responsibility.

### System prompt assembly

The system prompt is assembled from:
1. The `systemPromptTemplate` (or per-agent override).
2. `SKILLS_INSTRUCTION` block — injected when the active session exposes at least one skill via `SkillsModel.available`.

```
## Skills
You have access to specialized skills. Use the `use_skills` tool to search
and activate skills relevant to the current task. Once activated, skills
persist across turns until you reset them.
- Search: use_skills({ prompt: "describe the problem" })
```

**Source**: `src/context/context-window.ts`, `src/context/index.ts`.

## Compaction

Layered hierarchical compaction, run before each model call when a session may have grown beyond the configured budget. The compactor mutates the session tree by adopting old turns under `TurnGroup` wrappers; **it never drops data**.

### Algorithm

1. **Legacy migration** — once per compact call, no LLM. Migrates old summary format.
2. **Short-circuit** — if already under budget without any work (not even elision), return immediately.
3. **Pass loop** (up to `maxPassesPerCompact`):
   - **Step 1 — Elision projection.** Estimate with elision applied. If under budget, done.
   - **Step 2 — Form depth-1 group.** Group `groupSize` older turns (respecting `keepRecentTurns`) under a new `TurnGroup`. Summarise before adopting.
   - **Step 3 — Depth promotion.** When `depthPromoteThreshold` same-depth groups exist, promote a run of them to a higher-depth group.
   - **Step 4 — Context-thrash.** If no progress can be made, emit `context-thrash` event and break.

### Key invariants

- **Never drops data** — original Turns remain reachable as descendants of their `TurnGroup`.
- **Always summarises before adopting** — the `TurnGroup.summaryText` is produced by the configured `HierarchicalSummarizer`.
- **Pin policy honoured** — pinned nodes are never adopted into groups.
- **Stamps** — each compaction pass produces a unique `stamp` that is set on the new `TurnGroup`s, letting observers attribute groups to a specific compaction event.

### Context-thrash

Emitted when compaction cannot get the session under budget within `maxPassesPerCompact`. The model call still proceeds; the consumer sees the event in the log stream as `{ type: "context-thrash", turnId, stamp, budget, estimated }`.

**Source**: `src/context/context-compactor.ts`, `src/context/compaction-stamp.ts` (`newStamp`, `LEGACY_STAMP`).

## Selection

Projection from the tree to `ModelMessage[]` for one model call. Honours pin policy and elision; collapses `TurnGroup`s to their summaries unless a pinned descendant forces expansion.

The default strategy is `selectAll` — selects all messages in document order, expanding `TurnGroup`s to their `summaryText`. Alternative strategies can be passed via `ContextWindowOptions.selectStrategy`.

**Source**: `src/context/select-messages.ts` (`SelectionStrategy`, `selectAll`), `src/context/select-hierarchical.ts`.

## Elision

Projection-only shortening of tool-call results when forming `ModelMessage[]`. **Never mutates the tree.** Driven by `ToolElisionPolicy`.

The default policy (`createDefaultElisionPolicy`) truncates long tool results to a configurable length, replacing the middle with an ellipsis marker. The elided content is noted via a `tool_output_denied` node in the tree (for audit), but the original `ToolCall.result` is preserved.

**Source**: `src/context/tool-elision.ts` (`ToolElisionPolicy`, `createDefaultElisionPolicy`, `elideToolResponse`).

## Pin policy

Decides which nodes are protected from compaction (e.g., recent turns, user-flagged turns). Honoured by both compaction and selection.

The default is a no-pin policy — nothing is pinned. A `createPinPolicy` helper is available for custom policies.

**Source**: `src/context/pin-policy.ts` (`PinPolicy`, `createPinPolicy`, `containsPinned`).

## Token estimation

Used by compaction to decide when budget is exceeded and when elision/compaction has done enough.

```ts
type TokenEstimator = (text: string) => number;
function createTokenEstimator(): TokenEstimator;
```

**Source**: `src/context/token-estimator.ts`.

## Hierarchical summariser

Produces summary text for `TurnGroup` nodes. Required to enable budget compaction. The summariser is an injected dependency — the runtime does not provide a default.

**Source**: `src/context/hierarchical-summarizer.ts`.
