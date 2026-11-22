# @statewalker/ai-tasks

## What it is

The task queue of the AI harness (statewalker/statewalker-root#160, built by #206): one queue per
project, where people, agents, webhooks and schedules publish tasks under subjects, and
subscriptions (filters on subject with NATS-style `*` and `>`, destination and sender) peek, take
or claim them with leases. A task is removed once every matching subscription has acked or taken
it, or when it expires; after `max_attempts` failed leases it goes to the subscription's dead
letters. A task with `reply_to` (an inbox of its sender) asks for a reply, which only a consumer
that took or claimed it may send. An `Executor` (`run(lease, {signal, progress})`) is served by
`serveSubscription`, which keeps the lease, logs progress in the job log and replies with a
reference to it.

The envelope and the API carry no harness types, so the contract can move to a lower layer
unchanged (statewalker/statewalker-root#204). `TaskQueue` is the implementation over SQLite (a
Durable Object's `SqlStorage`, or anything with its `exec` shape); rights, modes and limits are the
host's (`ai-host-do`'s Workspace DO).

Part of the AI harness (statewalker/statewalker-root#111): see the
[repository's README](https://github.com/statewalker/statewalker-ai#readme), its
[glossary](https://github.com/statewalker/statewalker-ai/blob/main/GLOSSARY.md) and its
[threat table](https://github.com/statewalker/statewalker-ai/blob/main/docs/security.md).

## How to use it

```sh
npm install @statewalker/ai-tasks
```

```ts
import { serveSubscription, TaskQueue, type TasksApi } from "@statewalker/ai-tasks";
```

The harness is reached by clients through the session API of a running deployment (REST
`/v1/projects/{p}/tasks`, `/v1/projects/{p}/subscriptions`, `/v1/leases/{id}`, or RPC), not
through these packages; they are the deployment's parts.
