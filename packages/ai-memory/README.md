# @statewalker/ai-memory

## What it is

Memory across agent sessions (statewalker/statewalker-root#157): user preferences, user memory,
project memory and agent memory, each a folder of Markdown entries and attachments with front
matter. It holds the memory service (the atomic batch of the memory tool and the memory API, caps,
forget and erase, the scans on write and at load), the memory tool's schema, and priming.

Part of the AI harness (statewalker/statewalker-root#111): see the
[repository's README](https://github.com/statewalker/statewalker-ai#readme), its
[glossary](https://github.com/statewalker/statewalker-ai/blob/main/GLOSSARY.md) and its
[threat table](https://github.com/statewalker/statewalker-ai/blob/main/docs/security.md).

## How to use it

```sh
npm install @statewalker/ai-memory
```

```ts
import { MemoryService, memoryFiles, primingOf } from "@statewalker/ai-memory";
```

The harness is reached by clients through the session API of a running deployment, not through
these packages; they are the deployment's parts.
