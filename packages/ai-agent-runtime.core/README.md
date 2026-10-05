# @statewalker/ai-agent-runtime.core

## What it is

A workspace fragment that keeps a live `AgentRuntime` (from `@statewalker/ai-agent.core`) for the open workspace. It watches the active model (`ActiveModel`) and four contribution slots (`agent:tools`, `agent:skills`, `agent:system-prompt`, `agent:mcp-connections`), rebuilds the runtime when any of them change, and publishes the result through one adapter, `AgentRuntimeAdapter`. It contains no React code.

## Why it exists

`@statewalker/ai-agent.core` knows nothing about workspaces, adapters, commands or slots. An app still has to answer "which model is active?", "which tools, skills and MCP servers have other fragments contributed?" and "rebuild the agent when the user edits credentials". This fragment answers those questions in one place, so consumers read a single adapter instead of each assembling an `AgentRuntime` by hand.

## How to use

```sh
pnpm add @statewalker/ai-agent-runtime.core
```

No peer dependencies. The workspace (`@statewalker/workspace.core`) must already have the `Commands` (`@statewalker/shared-commands`) and `Slots` (`@statewalker/shared-slots`) adapters.

| Import path | Exports |
| --- | --- |
| `@statewalker/ai-agent-runtime.core` | `ActiveModel`, `AgentRuntimeAdapter`, `RebuildAgentCommand`, `agentToolsSlot`, `agentSkillsSlot`, `agentSystemPromptSlot`, `agentMcpConnectionsSlot`; types `RuntimeState`, `ActiveModelValue`, `AgentToolContribution`, `AgentSkillContribution`, `AgentMcpConnection`. |
| `@statewalker/ai-agent-runtime.core/fragment` | Default export: `init(ctx)`, which registers `ActiveModel` and `AgentRuntimeAdapter` and starts the rebuild manager. Returns an async cleanup function. |
| `@statewalker/ai-agent-runtime.core/internal/build-runtime` | `buildRuntime(input)`: the pure builder the manager uses. Exposed for tests. |

Register the fragment after the workspace bridge (so workspace lifecycle hooks exist) and before fragments that write `ActiveModel`, such as `@statewalker/ai-local-models.core`.

## Examples

### Start the fragment

```ts
import initAgentRuntime from "@statewalker/ai-agent-runtime.core/fragment";

const cleanup = initAgentRuntime(ctx);
// …
await cleanup();
```

### Get a ready agent

```ts
import { AgentRuntimeAdapter } from "@statewalker/ai-agent-runtime.core";

const adapter = workspace.requireAdapter(AgentRuntimeAdapter);
adapter.onUpdate(() => {
  const state = adapter.getState();
  if (state.status === "ready") {
    const session = state.agent.createSession({ title: "chat" });
    // state.runtime, state.activeProviderId, state.activeModelId
  } else if (state.status === "error") {
    console.error(state.message);
  }
});
```

### Contribute tools, skills, prompt text and an MCP server

```ts
import {
  agentMcpConnectionsSlot,
  agentSkillsSlot,
  agentSystemPromptSlot,
  agentToolsSlot,
} from "@statewalker/ai-agent-runtime.core";
import { Slots } from "@statewalker/shared-slots";

const slots = workspace.requireAdapter(Slots);

const removeTools = slots.provide(agentToolsSlot, (ctx) => createMyTools(ctx.files));
slots.provide(agentSkillsSlot, {
  name: "analyze-csv",
  description: "Summarize a CSV file.",
  content: "…skill instructions…",
});
slots.provide(agentSystemPromptSlot, "Prefer the wiki tools for project questions.");
slots.provide(agentMcpConnectionsSlot, {
  id: "docs",
  config: { url: "https://example.com/mcp" },
});
```

A tool contribution is a `ToolSet` or a factory that receives the runtime's filtered files view. Prompt blocks are appended to the default system prompt in contribution order. Duplicate MCP `id`s resolve last-wins.

### Select the model the agent uses

```ts
import { createAnthropic } from "@ai-sdk/anthropic";
import { ActiveModel } from "@statewalker/ai-agent-runtime.core";

workspace.requireAdapter(ActiveModel).set({
  kind: "remote",
  providerId: "anthropic",
  modelId: "claude-sonnet-4-20250514",
  createProvider: () => createAnthropic({ apiKey }),
});
```

### Force a rebuild

Use it when the provider must be rebuilt but the `ActiveModel` value is unchanged, for example after an API key edit:

```ts
import { RebuildAgentCommand } from "@statewalker/ai-agent-runtime.core";
import { Commands } from "@statewalker/shared-commands";

workspace.requireAdapter(Commands).call(RebuildAgentCommand, undefined);
```

## Internals

### One state value instead of many flags

```
ActiveModel ─┐
agent:tools ─┤                     ┌──────────────┐
agent:skills ┼─► debounce 25 ms ─► │ buildRuntime │ ─► AgentRuntimeAdapter.getState()
agent:system-prompt ┤              └──────────────┘     loading | ready | error
agent:mcp-connections ┘
RebuildAgentCommand ─┘
```

`RuntimeState` is a discriminated union: `loading`, `ready` (with `runtime`, `agent`, `activeProviderId`, `activeModelId`), `error` (with `message`), `no-providers`, `no-active-model`. This package sets only `loading`, `ready` and `error`; the other two are reserved for fragments that know about providers. Read `state.runtime` only in the `ready` branch.

### Why rebuilds are debounced and generation-checked

A burst of slot writes at startup would otherwise build the runtime many times. Changes are coalesced behind a 25 ms timer. A generation counter is captured before the async build and checked after it; if the workspace was closed or reopened in between, the result is dropped instead of published.

### What a rebuild does

`buildRuntime` creates an `AgentRuntime` over `workspace.files` with the system path `/.settings`, installs the built-in file tools as a factory (so they get the filtered tools view, never the raw workspace files), adds the contributed tools, skills and MCP servers, and calls `build()`. The manager then creates one agent named `chat` with the default system prompt plus the prompt blocks, bound to `ActiveModel.modelId`.

### Constraints

- When `ActiveModel` is empty or has no `modelId`, nothing is built and the state stays as it was (`loading` after a workspace load). An agent bound to an empty model id would fail on its first turn.
- Rebuilds are full rebuilds; there is no incremental patching of a live runtime. Open sessions keep the old runtime.
- One agent per rebuild. The system folder is fixed to `/.settings` through `init`.
- On workspace unload the runtime is dropped and the state returns to `loading`. The `RebuildAgentCommand` handler stays registered and does nothing while the workspace is closed.

### Dependencies

- `@statewalker/ai-agent.core`: `AgentRuntime`, `createFileTools` and the runtime types.
- `@statewalker/workspace.core`: workspace, adapters, lifecycle hooks.
- `@statewalker/shared-slots`, `@statewalker/shared-commands`, `@statewalker/shared-registry`, `@statewalker/shared-baseclass`: slots, the rebuild command, cleanup registry, observable adapters.
- `@statewalker/webrun-files`, `@ai-sdk/provider`: types.

## License

MIT
