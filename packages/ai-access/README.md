# @statewalker/ai-access

## What it is

Access for the harness: tokens and the issuer, roles and role sources, the permission
language and its translation to Datalog, modes and permission rules, approvals, and auto mode's
risk classifier. Capabilities are Biscuit tokens (webrun-biscuit): an agent session's capability
is its user's, narrowed to a project and session, and only ever narrows.

Part of the AI harness (statewalker/statewalker-root#111): see the
[repository's README](https://github.com/statewalker/statewalker-ai#readme), its
[glossary](https://github.com/statewalker/statewalker-ai/blob/main/GLOSSARY.md) and its
[threat table](https://github.com/statewalker/statewalker-ai/blob/main/docs/security.md).

## How to use it

```sh
npm install @statewalker/ai-access
```

```ts
import { WorkspaceAuthority, decideMode, BUILT_IN_MODES } from "@statewalker/ai-access";
```

The harness is reached by clients through the session API of a running deployment, not through
these packages; they are the deployment's parts.
