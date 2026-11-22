# @statewalker/ai-sessions

## What it is

User and agent sessions: turns queued and run one at a time, items, hierarchical summaries, the
event log, approvals, and the session API with its REST, server-sent-event and RPC transports.

Part of the AI harness (statewalker/statewalker-root#111): see the
[repository's README](https://github.com/statewalker/statewalker-ai#readme), its
[glossary](https://github.com/statewalker/statewalker-ai/blob/main/GLOSSARY.md) and its
[threat table](https://github.com/statewalker/statewalker-ai/blob/main/docs/security.md).

## How to use it

```sh
npm install @statewalker/ai-sessions
```

```ts
import { sessionRpcClient, handleSessionRest } from "@statewalker/ai-sessions";
```

The harness is reached by clients through the session API of a running deployment, not through
these packages; they are the deployment's parts.
