---
"@statewalker/ai-access": minor
"@statewalker/ai-sessions": minor
"@statewalker/ai-host-do": minor
---

The task queue comes from `@statewalker/shared-tasks` (statewalker/statewalker-root#406), and
`@statewalker/ai-tasks` leaves the repository. The contract is the same, with the queue's
`Executor` and `ExecutorContext` named `Processor` and `ProcessorContext` (`serveSubscription`
takes `processor`); the task API types `ai-sessions` exposes (`TasksApi`, `SessionApi`'s task
methods) are now shared-tasks'.

The task API gains what shared-tasks 0.1.0 adds (statewalker/statewalker-root#404):
- `cancel(project, task)`: the task's sender or `tasks.admin`; `POST /v1/projects/{p}/tasks/{id}/cancel` and over RPC. A cancelled lease's renew answers the new error code `ECANCELED` (409).
- `job(project, id, { after, wait_ms })`: resumes a job log after a stamp (`GET …/jobs/{id}?after=&wait_ms=`, up to 60 s); an ended job's last entry records `done`, `error` or `cancelled`.

A Workspace DO's queue written by ai-tasks 0.1.0 is upgraded in place when opened (schema
version 2: columns added with defaults, no data dropped); rolling back to ai-tasks is not
supported once a store is upgraded.
