# @statewalker/ai-agent

Domain language for the agent runtime: agent loop, conversation state, context shaping for model calls, tool/skill registries, model providers, and session persistence. The package is framework-free — UI and intents live in `@statewalker/ai-provider-core` and the consuming apps.

## Language

### Three-tier API

**AgentRuntime**:
Project-level entry point. Owns providers, tools, skills, the FilesApi split (system vs tools view), MCP clients, and session storage. Built once and stays alive for the host process.

**Agent**:
A *definition* — name, tools whitelist, skills whitelist, system prompt, default model, optional sub-agents. Loaded from `<systemPath>/agents/*.md` or created programmatically.
_Avoid_: agent instance, agent worker

**Session**:
A *runtime instance* bound to one Agent. Owns the conversation tree, inbox, per-session tool/skill views, and the agent loop. Persisted by id under `<systemPath>/sessions/`.

### Conversation state

**SessionState** (currently exposed as `state/Session`, scheduled for rename in #3):
The persisted state of one Session — the tree of Turns, Messages, ToolCalls, and TurnGroups. Pure data; a typed view over `TreeNode`. The runtime Session holds it as `.state`.
_Avoid_: ConversationTree, SessionNode (existing alias used to disambiguate)

**Turn**:
One inbox-message exchange — opens with a user message, accumulates agent messages, tool calls, and tool results, closes when streaming finishes. Exactly one Turn per inbox message (invariant of the agent loop).

**TurnGroup**:
A summarised run of Turns produced by compaction. Wraps adopted children; carries `depth`, `stamp`, and a `summaryText`. Never drops data — original Turns remain reachable as descendants.

**Inbox**:
Async queue of pending user messages. The agent loop drains it; one `take()` per Turn.

**TreeNode**:
The underlying typed node primitive. Implementation detail of the state tree — callers work through `Session`/`Turn`/`Message`/etc. accessors.

### Agent loop

**TurnDriver** (deepening opportunity #2):
Advances a `SessionState` by one **Turn** given one inbox message. Owns the per-turn lifecycle: open Turn, optional first-turn skill selection, ContextWindow build, `streamText` invocation, stream-part routing, finish classification, error recording. Stateless across turns; takes the tree per call.
_Avoid_: agent controller, turn runner

**AgentController** (scheduled for removal in opportunity #2):
Legacy orchestrator that mixed the inbox loop, per-turn lifecycle, skill selection, title generation, and stream-part routing in one class. Being decomposed into `Session.run()` (inbox loop + first-turn title) and `TurnDriver` (per-turn work).

### Context shaping

**ContextWindow**:
The module that, given the current `SessionState` and the active `SkillsModel`, produces `{ system, messages, events, stats }` for one model call. Internally orchestrates compaction, selection, elision, pin policy, summarisation, and system-prompt assembly. Mutates the tree (compaction artifacts persist); returns a projected snapshot. One instance per Session — constructed by `runtime/Session` from runtime defaults plus per-agent overrides.
_Avoid_: context builder, context manager, prompt builder

**compaction**:
Tree-shaping that adopts older Turns under `TurnGroup` wrappers when token budget is exceeded. Hierarchical — depth-1 groups can be promoted to depth-2 and beyond. Always summarises before adopting; never drops data.

**elision**:
Projection-only shortening of tool-call results when forming `ModelMessage[]`. Never mutates the tree. Driven by `ToolElisionPolicy`.

**pin policy**:
Decides which nodes are protected from compaction (e.g., recent turns, user-flagged turns). Honoured by both compaction and selection.

**selection**:
Projection from the tree to `ModelMessage[]` for one model call. Honours pin policy and elision; collapses TurnGroups to their summaries unless a pinned descendant forces expansion.

**stamp**:
Identifier marking a set of TurnGroups produced in the same compaction pass. Lets observers attribute groups to a specific compaction event.

**context-thrash**:
The event emitted when compaction cannot get the session under budget within `maxPassesPerCompact`. The model call still proceeds; the consumer sees the event in the log stream.

### Tools and skills

**ToolRegistry**:
Per-session collection of named tools available to the agent. Built from runtime-wired tools plus MCP-bridged tools plus per-Agent whitelist.

**SkillsModel**:
Per-session collection of `available` and `selected` skills. Skills are markdown files loaded from `<systemPath>/skills/`. Selected skills inject their content into the system prompt.

**skill**:
A markdown file with a YAML frontmatter — declarative guidance the agent can activate via the `use_skills` tool.

### Models

**ModelManager**:
Manages local-engine model lifecycle: registration, download, verification, activation, weight storage. Distinct from cloud providers (Anthropic/OpenAI/Google), which are passed in directly as `ProviderV3`.

**ModelStateStore as ProviderV3**:
`ModelStateStore` implements `ProviderV3` directly (`specificationVersion = "v3"`, `languageModel(id)`, `embeddingModel`/`imageModel` throw `NoSuchModelError`). `AgentRuntime.addModelProvider()` accepts only `ProviderV3`. Callers holding a `ModelManager` pass `modelManager.provider` (a getter that returns the underlying store typed as `ProviderV3`).

### Files

**FilesApi split**:
The `AgentRuntime` builds two views over the root `FilesApi`: a **system view** (full visibility — config, secrets, agents, skills, sessions) and a **tools view** (system path-tree hidden via `FilteredFilesApi`). Tools and skills receive the tools view through `AgentContext.files`.

**FilesSplit** (deepening opportunity #4):
The module that, given a root `FilesApi` and the system/user path geometry, returns `{ systemFiles, toolsFiles, paths }`. Owns the geometry validation and the path-normalisation helpers (`normalizeFolderPath`, `isUnderSystem`, `toSystemRelative`). Tested in isolation; AgentRuntime calls it once during `build()`.

**AgentCatalog** (deepening opportunity #4):
Registry of `Agent` definitions — owns the name → `Agent` map, dup-name validation, and disk loading from `<agentsPath>/*.md`. Replaces the inline `_agents` Map + `createAgent`/`getAgent`/`agents()` + the agent-loading step inside `AgentRuntime.build()`.

**SkillsLoader** (deepening opportunity #4):
Resolves the runtime's `SkillInfo[]` from a `FilesApi` skills folder plus any manually-registered skills. Owns the markdown-walk + parse loop.

## Relationships

- An **AgentRuntime** owns many **Agents** and creates many **Sessions**.
- A **Session** is bound to exactly one **Agent** and owns one **SessionState**, one **Inbox**, one **ToolRegistry**, and one **SkillsModel**.
- A **SessionState** contains many **Turns** and **TurnGroups** as direct children.
- A **TurnGroup** adopts a contiguous run of **Turns** or lower-depth **TurnGroups**.
- The **ContextWindow** reads a **SessionState** + **SkillsModel** and produces inputs for one model call; it may mutate the tree via compaction.
- The **TurnDriver** uses a **ContextWindow** to build the model-call inputs, then advances the **SessionState** by exactly one **Turn** per call.
- A **Session** owns one **TurnDriver** and one **ContextWindow**; `Session.run()` drains the **Inbox** and delegates each message to `TurnDriver.drive()`.
- **compaction** produces **TurnGroups**; **selection** projects the tree to `ModelMessage[]` honouring **pin policy** and **elision**.

## Example dialogue

> **Dev:** "When the model loop opens a new **Turn**, does **compaction** run before or after?"
> **Domain expert:** "Before. The **ContextWindow** is built per model call — compaction is its first step, then selection projects the tree. The fresh Turn the loop just opened is empty at that point, so it's always pinned by the recent-tail rule."

> **Dev:** "If **elision** never mutates the tree, where does the elided text live?"
> **Domain expert:** "Only in the **ModelMessage[]** that **selection** produces. The tool result on the **ToolCall** stays full-fidelity in the **SessionState** — reload the session and you see the original."

## Flagged ambiguities

- **Session** is used at two layers: `state/Session` (a typed `TreeNode`) and `runtime/Session` (the orchestrator wrapping it). Resolved in opportunity #3 by renaming the state-side to **SessionState** and moving runtime-Session wiring out of its constructor into `Agent.createSession()`.
- "context" alone is ambiguous — could mean `AgentContext` (the DI bag passed to tool factories) or the **ContextWindow** (the model-call inputs). Prefer the full term.
