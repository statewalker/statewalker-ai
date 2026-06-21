# @statewalker/ai-agent-runtime

## What it is

The workbench logic-fragment that owns a live, rebuildable `AgentRuntime`. It projects the workspace's active model selection plus three contribution slots (`agent:tools`, `agent:skills`, `agent:mcp-connections`) into a single discriminated `RuntimeState`, and rebuilds the underlying `AgentRuntime` whenever any of those inputs change. Consumers (the chat surface, other fragments) read one adapter to learn whether the agent is usable and to get the built `AgentRuntime` + `Agent` when it is.

## Why it exists

`@statewalker/ai-agent` is framework-free: it knows nothing about the workspace, its adapters, its command bus, or its slot system. Something has to glue the agent engine to the running app — answer "which provider/model is active?", "what tools/skills/MCP servers has the app contributed?", and "rebuild the runtime when the user edits credentials." This fragment is that glue. It keeps `@statewalker/ai-agent` portable while giving the host a single reactive entry point (`AgentRuntimeAdapter`) instead of forcing every consumer to assemble an `AgentRuntime` by hand.

Per ADR 0002 it is logic-only — no React imports. The reactive adapters are plain `BaseClass` observables; React consumers reach them through the `useAdapter` hook in the view layer.

## How to use

```sh
pnpm add @statewalker/ai-agent-runtime
```

The package is a fragment: its default export is an `init(ctx)` function that registers the adapters and the rebuild orchestrator against the workspace. Register it **after** the workspace bridge so workspace lifecycle hooks are wired; the providers fragment (which writes `ActiveModel`) registers **after** this one.

```ts
import initAgentRuntime from "@statewalker/ai-agent-runtime/fragment";
// ... in your fragment boot sequence:
const cleanup = initAgentRuntime(ctx);
```

Once registered, three pieces are available on the workspace:

- **`AgentRuntimeAdapter`** — read `getState()` for the current `RuntimeState`.
- **`ActiveModel`** — the resolved provider+model pointer (written by the providers fragment, observed here).
- **`agentToolsSlot` / `agentSkillsSlot` / `agentMcpConnectionsSlot`** — contribution points; anything dropped into them is folded into the next rebuild.

## Examples

### Reading the runtime state

```ts
import { AgentRuntimeAdapter } from "@statewalker/ai-agent-runtime";

const adapter = workspace.requireAdapter(AgentRuntimeAdapter);
const state = adapter.getState();

if (state.status === "ready") {
  const session = state.agent.createSession({ title: "chat" });
  // state.runtime, state.activeProviderId, state.activeModelId also available
} else {
  // "loading" | "no-providers" | "no-active-model" | "error"
}
```

`RuntimeState` is the single source of truth — never peek at the underlying `AgentRuntime` outside the `ready` branch.

### Contributing tools, skills, MCP servers

```ts
import {
  agentToolsSlot,
  agentSkillsSlot,
  agentMcpConnectionsSlot,
} from "@statewalker/ai-agent-runtime";
import { Slots } from "@statewalker/shared-slots";

const slots = workspace.requireAdapter(Slots);

slots.provide(agentToolsSlot, (ctx) => createMyTools(ctx.files));
slots.provide(agentSkillsSlot, { name: "analyze-csv", description: "…", body: "…" });
slots.provide(agentMcpConnectionsSlot, {
  id: "filesystem",
  config: { command: "npx", args: ["@modelcontextprotocol/server-filesystem", "/data"] },
});
```

Each slot write schedules a (debounced) rebuild. Duplicate MCP `id`s are resolved last-wins.

### Setting the active model

`ActiveModel` is normally written by the providers fragment, but its shape is public:

```ts
import { ActiveModel } from "@statewalker/ai-agent-runtime";
import { createAnthropic } from "@ai-sdk/anthropic";

workspace.requireAdapter(ActiveModel).set({
  kind: "remote",
  providerId: "anthropic",
  modelId: "claude-sonnet-4-20250514",
  createProvider: () => createAnthropic({ apiKey }),
});
```

### Forcing a rebuild

After a credentials edit that doesn't change the `ActiveModel` reference, fire the command:

```ts
import { RebuildAgentCommand } from "@statewalker/ai-agent-runtime";
import { Commands } from "@statewalker/shared-commands";

workspace.requireAdapter(Commands).call(RebuildAgentCommand);
```

## Internals

### Architectural decisions

- **Three-input projection.** `AgentRuntimeManager` observes exactly four sources — `ActiveModel.onUpdate` plus the three slots — and collapses them into one `RuntimeState`. Nothing else triggers a rebuild.
- **`ActiveModel` carries a `createProvider()` factory, not an id.** The pointer ships a concrete `ProviderV3` factory so the manager builds against it directly without re-resolving the provider by id at rebuild time. `kind: "remote"` and `kind: "local"` share the same `ProviderV3` shape so `AgentRuntime` treats them uniformly.
- **`ActiveModel` is a "last-selected hint", not the gate** (ADR 0011). It remains the workspace-singular pointer that determines which provider the runtime builds against, but the user-facing selection is per-session; new sessions inherit `ActiveModel` as their initial `modelRef`.
- **`build-runtime.ts` is a pure builder.** `buildRuntime(input)` takes fully-resolved inputs and returns a built `AgentRuntime`; it installs the built-in file tools (`createFileTools`) as a `ToolFactory` so they receive the runtime's filtered tools-view (never the raw workspace files), then folds in slot-contributed tools/skills/MCP. It is exposed at `./internal/build-runtime` so tests can call it without the manager.
- **Lifetime- vs cycle-scoped subscriptions.** The `RebuildAgentCommand` handler lives for the manager's whole lifetime, so a late `runRebuildAgent` while the workspace is closed simply no-ops. The slot/`ActiveModel` subscriptions are per workspace-open cycle, torn down on `onUnload`.

### Algorithms

- **Debounced, generation-guarded rebuild.** Every input change calls `_scheduleRebuild`, which coalesces bursts behind a 25 ms timer. A monotonic `_generation` counter is captured at the start of each rebuild and re-checked after the async `buildRuntime`/`createAgent`; if the workspace cycled (open/unload) under an in-flight rebuild, the stale result is discarded rather than published.
- **State transitions.** `onLoad` resets to `{ status: "loading" }` and schedules the first rebuild. A rebuild with no `ActiveModel` leaves the current state untouched (the `no-providers` vs `no-active-model` distinction is owned by the providers fragment). A successful build publishes `ready` with the runtime + a `chat` agent; a thrown error publishes `error` with its message. `onUnload` drops the runtime and returns to `loading`.

### Constraints

- One agent definition (`name: "chat"`) with a fixed default system prompt is created per rebuild; multi-agent fan-out is not modelled here.
- The system folder defaults to `/.settings`; override via `AgentRuntimeManagerOptions.systemFolder` (not surfaced through the fragment init).
- Rebuilds are full rebuilds — there is no incremental tool/skill patching of a live `AgentRuntime`.

### Dependencies

- `@statewalker/ai-agent` — the agent engine being built and managed (`AgentRuntime`, `createFileTools`, runtime types).
- `@statewalker/workspace.core` — `Workspace`, `getWorkspace`, the adapter host and lifecycle hooks.
- `@statewalker/shared-baseclass` — `BaseClass` for the reactive adapters.
- `@statewalker/shared-commands` — `RebuildAgentCommand` and the command bus.
- `@statewalker/shared-registry` — `newRegistry` for scoped cleanup.
- `@statewalker/shared-slots` — `defineSlot`/`Slots` for the three contribution points.
- `@statewalker/webrun-files` — `FilesApi` typing passed into `buildRuntime`.
- `@ai-sdk/provider` — `ProviderV3` typing for `ActiveModelValue`.

## Related

- `@statewalker/ai-agent` — the framework-free agent engine this fragment drives.
- `@statewalker/ai-config` — the unified AI configuration adapter; the providers fragment that consumes it writes `ActiveModel`.
- `@statewalker/workspace.core` — the workspace/adapter substrate.

## License

MIT — see the monorepo root `LICENSE`.
