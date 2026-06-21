<!--
  README.draft.md — produced by /grill-module. Follows the published README
  format in `.claude/rules.md` § "README Files". Sections starting as TBD
  fill in as the grill session resolves them. On promotion to README.md:
  rename this file and strip the `<!-- DRAFT ONLY -->` block at the bottom.
-->

# @statewalker/ai-agent

## What it is

TypeScript library for building multi-turn AI agents with persistent
conversation state, a reactive control surface, and session resume. Built on
the [Vercel AI SDK](https://sdk.vercel.ai/) for model streams and
[`@statewalker/shared-commands`](../../../statewalker-shared/packages/shared-commands/)
for the tool surface. The package is framework-free — no UI, no
workspace-adapter coupling.

## Why it exists

A single agent runtime that handles the loop, conversation tree, context
shaping, and persistence — and nothing else.

v1 owned its own tool registry, MCP integration, and built-in file tools.
**v2 delegates all of that to the Commands substrate**: tools / MCP / external
APIs / future sub-agents are Commands brought in by adapter packages outside
ai-agent. The runtime takes a `Commands` bus + a `CommandsRegistry`, projects
the registry into Vercel-AI-SDK tools via one generic bridge, and stays
focused on what's irreducibly its job:

- **Turn lifecycle** — `TurnDriver` advances a `SessionState` by one Turn per
  invocation; `Session.run` drives it, draining the `Inbox` and continuing
  autonomously when the previous Turn ended with pending tool calls.
- **Conversation state** — `SessionState` is a reactive tree of Turns,
  Messages, ToolCalls, TurnGroups. Pin policy, selection, elision, and
  hierarchical compaction shape the model-call inputs.
- **Reactive control surface** — `session.observe(nodeType, …)` for
  read-only telemetry; `session.gate(nodeType, …)` for in-turn decisions
  (HITL, policy gates) via typed accessors over pending nodes.
- **Skills + agent definitions** — markdown-loaded from disk; injected into
  the system prompt; selectable via the model-facing `use_skills` tool.
- **Models** — `ModelManager` for local-engine lifecycle alongside cloud
  `ProviderV3`s passed in directly.
- **Persistence** — sessions serialised by id under `<systemPath>/sessions/`.

What's *not* here: MCP wiring (planned — package not yet created), file tools
(→ `@statewalker/fragment-file-tools` or similar), `addTools` / `setMcpServers`
runtime setters (removed), `addSubAgent` (removed; sub-agents return as
external Commands when the adapter pattern lands).

## How to use

Install:

```sh
pnpm add @statewalker/ai-agent @statewalker/shared-commands
```

Three-tier API:

```
AgentRuntime   ─→   Agent (definition)   ─→   Session (runtime instance)
```

- **`AgentRuntime`** — project-level entry point. Owns providers, skills,
  agent definitions, session storage, file-path geometry. Holds the
  `Commands` bus and `CommandsRegistry` passed in via `.setCommands(…)` /
  `.setRegistry(…)`.
- **`Agent`** — a definition: name, tools whitelist (becomes a
  `CommandsRegistry.filter`), skills whitelist, system prompt, default model.
  Cheap to construct.
- **`Session`** — a runtime instance bound to one Agent. Owns the
  conversation tree, inbox, gate registrations, and the loop. Persisted by id.

See [Examples](#examples) for the full DX. API surface:

| Concept | Entry point |
|---|---|
| Build a runtime | `new AgentRuntime({ files }).setCommands(…).setRegistry(…).addModelProvider(…).build()` |
| Declare an Agent | `runtime.createAgent({ name, defaultModel, systemPrompt, tools?, skills?, maxSteps?, maxAutonomousTurns? })` |
| Create a Session | `agent.createSession({ title?, sessionId?, maxAutonomousTurns? })` |
| Send + run | `session.send(text); for await (const log of session.run(signal?)) { … }` |
| Observe state changes | `session.observe(nodeType, cb) → dispose` |
| Gate pending nodes | `session.gate(nodeType, decideFn) → dispose` |
| Persist | `session.save({ title? })` |
| Resume | `runtime.loadSession(id)` |

### Sub-path exports

| Export Path | Description |
|---|---|
| `@statewalker/ai-agent/runtime` | `AgentRuntime`, `Agent`, `Session`, runtime types, FilesApi helpers. The official entry point. |
| `@statewalker/ai-agent/state` | `TreeNode`, `SessionState`, `Turn`, `TurnGroup`, `Message`, `ToolCall`, `Inbox`, `NodeType`, `LogMessage`, typed pending-node accessors (`ToolRequestNode`, …). |
| `@statewalker/ai-agent/models` | `ModelManager`, `LocalModelStorage`, model catalog, remote discovery, provider/model types. |

The bare `@statewalker/ai-agent` root is intentionally empty; go through one
of the sub-paths. `tools/` and `mcp/` sub-paths are **removed** in v2 — tool
surfaces and MCP are owned by external adapter packages.

## Examples

### Minimal usage

```ts
import { AgentRuntime } from "@statewalker/ai-agent/runtime";
import { Commands, CommandsRegistry } from "@statewalker/shared-commands";
import { NodeFilesApi } from "@statewalker/webrun-files-node";
import { createAnthropic } from "@ai-sdk/anthropic";

import { createFileToolsRegistry } from "@statewalker/fragment-file-tools";

const files = new NodeFilesApi({ rootDir: "/my/project" });

// 1. Build the shared substrate (Commands + Registry) — host owns it.
const commands = Commands.create();
const registry = CommandsRegistry.compose(
  createFileToolsRegistry({ files, commands }),
);

// 2. Build the runtime — file path geometry + provider + the substrate.
const runtime = await new AgentRuntime({ files })
  .setCommands(commands)
  .setRegistry(registry)
  .addModelProvider(createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY }))
  .build();

// 3. Declare an Agent — definition only.
const assistant = runtime.createAgent({
  name: "assistant",
  defaultModel: "claude-sonnet-4-7",
  systemPrompt: "You are a helpful assistant.",
});

// 4. Run a Session.
const session = assistant.createSession({ title: "first chat" });
session.send("List the markdown files in /docs.");

for await (const log of session.run()) {
  console.log(log.kind, log.content);
}

await session.save();
```

What changed from v1:

- `.addTools(...)` and `.setMcpServers(...)` are **removed**. Tools come from
  the `CommandsRegistry` passed via `.setRegistry(...)`.
- `.setCommands(c)` and `.setRegistry(r)` are **new** fluent setters; optional
  with internal defaults.
- All other setters (`setSystemPath`, `setUserPath`, `setSessionsPath`,
  `setSkillsPath`, `setAgentsPath`, `setConfigPath`, `addSkills`,
  `addModelProvider`, `setSelectionStrategy`, `setBudgetCompaction`,
  `setErrorHandler`) **stay** — these are file-path geometry, provider, and
  context-shaping concerns unaffected by the substrate change.

### Tree-mutation control surface

The reactive `SessionState` tree is the control surface for in-turn flow.
Two seams sit on top of it — **observation** (read-only, many subscribers)
and **gating** (single decision-maker per node-type, blocks the loop).

```ts
import { NodeType } from "@statewalker/ai-agent/state";

const session = assistant.createSession();

// Observation — read-only, many subscribers, never blocks flow.
const stopAudit = session.observe(NodeType.toolCall, (node) => {
  metrics.toolCalled.inc({ tool: node.toolName });
  audit.log(node);
});

// Gating — one per node-type; the turn loop awaits the verdict.
const stopGate = session.gate(NodeType.toolRequest, async (toolRequest) => {
  const verdict = await showApprovalUi({
    tool: toolRequest.toolName,
    args: toolRequest.args,
  });
  if (verdict.kind === "approved") toolRequest.approve();
  else if (verdict.kind === "denied") toolRequest.deny(verdict.reason);
  else if (verdict.kind === "rewrite") toolRequest.approveWith(verdict.args);
});

session.send("delete every .ts file");
for await (const log of session.run()) { /* ... */ }

stopAudit();
stopGate();
```

The presence of a gate is the policy. **No gate registered → pending nodes of
that type auto-approve, the loop never waits.** Adding a gate flips the
default. Internally, `TurnDriver` reads each pending node via `waitForValue`
on `node.onUpdate` (from `@statewalker/shared-baseclass`); the gate's typed
accessor methods mutate the node's `status` to release the wait.

Typed accessors (`ToolRequestNode`, …) expose allowed-transition methods
(`approve` / `deny` / `approveWith`) over the generic `status: string` field,
so consumers can't put a node into an invalid state.

### Failure / edge path

```ts
// 1. Autonomous loop hits the cap — agent is cut off mid-task.
const session = assistant.createSession({ maxAutonomousTurns: 5 });
session.send("paginate through everything until done");
for await (const log of session.run()) {
  if (log.kind === "turn-finish" && log.finishKind === "step-limit") {
    // agent was capped; UI can show a "continue?" affordance.
  }
}

// 2. Agent calls wait_for_user — loop pauses for the next inbox message.
session.send("ask me a clarifying question");
for await (const log of session.run()) { /* logs the ask */ }
// Loop exited because the agent's last tool call was wait_for_user.
session.send("here's the answer");
for await (const log of session.run()) { /* continues */ }

// 3. Abort signal — caller cancels; the in-flight Turn is recorded as aborted.
const ctrl = new AbortController();
setTimeout(() => ctrl.abort(), 5_000);
for await (const log of session.run(ctrl.signal)) { /* runs up to 5s */ }

// 4. Gate denies a tool call — agent receives the denial as the tool's result.
session.gate(NodeType.toolRequest, async (req) => req.deny("policy violation"));
session.send("delete /etc/passwd");
for await (const log of session.run()) { /* agent sees denial, plans differently */ }
```

**Built-in commands** — `wait_for_user`, `list_tools`, `list_skills`,
`use_skills` are registered by ai-agent internally into a private
`MutableCommandsRegistry` composed with the caller-provided registry. Consumers
never import them. To detect "the agent is asking for input," observe the
`SessionState` tree (`session.observe(NodeType.toolCall, ...)`) rather than
listening on the bus.

## Internals

TBD — fills in during implementation, not during the grill.

### Constraints

TBD — limitations, known edge cases, capacity bounds.

### Dependencies

TBD — what this module depends on and why.

## License

MIT © statewalker

<!-- DRAFT ONLY — strip before promotion to README.md -->

## Test Goals

High-level testable contracts. Formal `Requirement: / Scenario:` blocks live in
`openspec/changes/<name>/specs/<name>/spec.md`, generated from this list by
`/opsx:propose`.

**Runtime construction**

- `.setCommands(c)` and `.setRegistry(r)` are optional; if absent, the runtime
  builds `Commands.create()` and `CommandsRegistry.create()` defaults internally.
- `.addTools(...)`, `.setMcpServers(...)`, `.setMcpConfigFile(...)`, and
  `.setToolsPath(...)` are removed from the v2 surface.
- `.build()` is idempotent — second call returns the same materialised runtime.

**Agent definitions**

- `runtime.createAgent({ tools: [...] })` projects the runtime's registry
  through a `CommandsRegistry.filter` keyed by the listed names.
- Duplicate agent names throw on `createAgent`.
- `Agent.createSession` writes `state.props.agent = this.name` so a later
  `loadSession` can re-bind deterministically.
- `loadSession` throws when the persisted agent name is not registered in the
  runtime's agent catalog (no synthetic `__resumed__` fallback).

**Session.run loop**

- The loop drives a Turn iff: the inbox has messages, or the previous Turn
  ended with a tool-calls finish AND the last tool call was not `wait_for_user`.
- Exactly one Turn is appended to `state.turns` per `drive()` invocation.
- `maxAutonomousTurns` caps consecutive Turns without inbox input; arriving
  inbox messages reset the counter.
- A Turn cut off by the autonomous cap surfaces as `turn-finish` with
  `finishKind = "step-limit"`.

**Built-in commands**

- `wait_for_user`, `list_tools`, `list_skills`, `use_skills` are registered by
  the runtime into a private `MutableCommandsRegistry` composed with the
  caller-provided registry.
- The caller-provided registry's `list()` does not include the built-ins
  (consumer-visible registry stays clean).

**Tree-mutation control surface**

- `session.observe(nodeType, cb)` invokes `cb(node)` synchronously on each
  mutation matching `nodeType`; multiple observers per node-type are allowed.
- `session.observe` returns a disposer; double-disposal is a no-op.
- `session.gate(nodeType, fn)` throws if a gate is already registered for that
  node-type; calling the disposer first allows re-registration.
- A pending node of a gated type blocks the Turn loop until the gate's typed
  accessor methods (`approve` / `deny` / `approveWith`) mutate `status`.
- A pending node of an *ungated* type auto-approves; the Turn loop does not wait.

**Persistence**

- `session.save()` writes the serialised `SessionState` to
  `<sessionsPath>/<id>.json` and resolves with the session id.
- `runtime.loadSession(id)` reads, deserialises, and binds the session to the
  Agent named in `state.props.agent`.
- A session saved mid-await on a pending node round-trips: on reload, the
  pending node's `status` is preserved and the loop re-arms `waitForValue`.

**Failure modes**

- Aborting the `signal` passed to `session.run(signal)` aborts the in-flight
  Turn; the Turn is recorded with `finishKind = "aborted"`.
- A command rejected with `CommandError("input-validation")` or any other
  `CommandError.kind` surfaces as a `turn-error` log message; the loop
  continues unless aborted.

<!-- END DRAFT ONLY -->
