# @statewalker/ai-tasks

## 0.1.0

### Minor Changes

- 66c5454: The task queue (statewalker/statewalker-root#206): the new `ai-tasks` package (tasks, subscriptions
  with NATS-style filters, peek, take and leased claims with dead letters, reply inboxes, the
  `Executor` contract and `serveSubscription`), one queue per project in the Workspace DO, the task
  API over REST and RPC (`/v1/projects/{p}/tasks`, `/v1/projects/{p}/subscriptions`, `/v1/leases/{id}`,
  SSE `changed` notifications), the agent tools `tasks_publish`, `tasks_peek`, `tasks_take` and
  `tasks_reply` (publishing under the mode; `plan` denies it), and the queue counted as storage.
