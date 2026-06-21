# `ai-agent` lives in `statewalker-workbench` as a domain, not in a library repo

`ai-agent` is a standalone, workspace-free library (the `AgentRuntime → Agent →
Session` tree; deps are only external substrate — `shared-*`, `webrun-*`). A reader
might expect a library with no workbench coupling to live alongside `shared-*` in
`statewalker-shared` or its own repo. We deliberately keep it **in the workbench**
and name it under the workbench convention as `@statewalker/ai-agent.core`. The same
applies to `ai-openai-compat` (→ `ai-openai-compat.core`).

## Considered Options

- **Keep in workbench as a `.core` domain (chosen)** — precedent: `backbone.core` is
  also a workspace-free foundational library that lives in workbench as a dotted
  domain. The AI stack was just consolidated *into* workbench (the `statewalker-ai`
  gitlink is being dropped); relocating `ai-agent` back out would reverse that. No
  consumer outside `statewalker-workbench` + `statewalker-apps` imports it today, so
  there is no reuse pressure to justify a separate repo.
- **Relocate to a library repo** — rejected as speculative: it is cross-repo churn
  plus a new repo to maintain, bought against a reuse scenario that does not exist
  yet (Karpathy §2, no features-for-features).

## Consequences

- A workspace-free library sits in `workbench/packages` under `.core`. This is
  intentional and consistent with `backbone.core`, not an oversight.
- **Revisit tripwire:** if a consumer *outside* the `statewalker-workbench` +
  `statewalker-apps` umbrella begins importing `ai-agent` (a standalone CLI, a
  server, a third party), reopen this and relocate it to a dedicated library repo —
  at which point it would keep suffix-style naming and become exempt from the dotted
  workbench convention.
