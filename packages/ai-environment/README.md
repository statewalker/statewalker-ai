# @statewalker/ai-environment

## What it is

The environment agents work in: the gated file view (system folder, membership, ignore rules,
per-block re-authorization), the files-RPC server, databases, the model gateway (providers, models
and aliases at four levels, fallback, metering), secrets (sealed, bound to plugins and hosts,
injected at the last moment) and limits.

Part of the AI harness (statewalker/statewalker-root#111): see the
[repository's README](https://github.com/statewalker/statewalker-ai#readme), its
[glossary](https://github.com/statewalker/statewalker-ai/blob/main/GLOSSARY.md) and its
[threat table](https://github.com/statewalker/statewalker-ai/blob/main/docs/security.md).

## How to use it

```sh
npm install @statewalker/ai-environment
```

```ts
import { gatedFiles, ModelGateway, SecretStore } from "@statewalker/ai-environment";
```

A browser page that runs the harness declares its local model engine before it starts the
deployment, so the gateway's `local` provider serves models in the page (statewalker/statewalker-root#143);
without one, `local` models answer `ENOSYS`. The page downloads weights only when its user asks:

```ts
import { installLocalEngine } from "@statewalker/ai-environment/local-models";
import { webllmEngine } from "@statewalker/ai-environment/webllm";

const engine = webllmEngine({ load: () => import("@mlc-ai/web-llm") });
installLocalEngine(engine);
await engine.download("SmolLM2-360M-Instruct-q4f16_1-MLC", (p) => console.log(p.text)); // the user's action
```

The harness is reached by clients through the session API of a running deployment, not through
these packages; they are the deployment's parts.
