# @statewalker/ai-flue

## What it is

Agent sessions on Flue's Cloudflare-target runtime: each turn one Flue submission, its model
calls through the harness's model gateway, its tools the harness's (files through the gate, host
tools, sub-agents), its context the session's shaped history.

Part of the AI harness (statewalker/statewalker-root#111): see the
[repository's README](https://github.com/statewalker/statewalker-ai#readme), its
[glossary](https://github.com/statewalker/statewalker-ai/blob/main/GLOSSARY.md) and its
[threat table](https://github.com/statewalker/statewalker-ai/blob/main/docs/security.md).

## How to use it

```sh
npm install @statewalker/ai-flue
```

Used by `@statewalker/ai-host-do`'s Agent DO; importing it pulls `cloudflare:workers`.

The harness is reached by clients through the session API of a running deployment, not through
these packages; they are the deployment's parts.
