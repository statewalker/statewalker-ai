# @statewalker/ai-definitions

## What it is

Plugin sources in, definitions out: the plugin loader (Agent Plugins 1.0 and Claude Code
layouts), the catalog of agents, skills and tools, each role's `.agents/` view, and tool
definitions (one OpenAPI 3.1 operation each, REST imports included).

Part of the AI harness (statewalker/statewalker-root#111): see the
[repository's README](https://github.com/statewalker/statewalker-ai#readme), its
[glossary](https://github.com/statewalker/statewalker-ai/blob/main/GLOSSARY.md) and its
[threat table](https://github.com/statewalker/statewalker-ai/blob/main/docs/security.md).

## How to use it

```sh
npm install @statewalker/ai-definitions
```

```ts
import { toolDefinition, catalogTools } from "@statewalker/ai-definitions";
```

The harness is reached by clients through the session API of a running deployment, not through
these packages; they are the deployment's parts.
