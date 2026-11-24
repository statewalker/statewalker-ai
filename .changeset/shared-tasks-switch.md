---
"@statewalker/ai-sessions": minor
"@statewalker/ai-host-do": minor
---

The task queue comes from `@statewalker/shared-tasks` (statewalker/statewalker-root#406), and
`@statewalker/ai-tasks` leaves the repository. The contract is the same, with the queue's
`Executor` and `ExecutorContext` named `Processor` and `ProcessorContext` (`serveSubscription`
takes `processor`); the task API types `ai-sessions` exposes (`TasksApi`, `SessionApi`'s task
methods) are now shared-tasks'. A Workspace DO's queue written by ai-tasks 0.1.0 opens as it is;
rolling back to ai-tasks is not supported once shared-tasks has written to a store.
