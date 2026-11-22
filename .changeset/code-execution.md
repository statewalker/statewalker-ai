---
"@statewalker/ai-access": minor
"@statewalker/ai-environment": minor
"@statewalker/ai-definitions": minor
"@statewalker/ai-sessions": minor
"@statewalker/ai-flue": minor
"@statewalker/ai-host-do": minor
---

Code execution (statewalker/statewalker-root#142): the agent's `bash` tool routes `node`, `python` and
the deployment's WASIX programs to an executor (`EXECUTORS`). `node` scripts are bundled from the
session's files, held to the acceptance check and run in a Worker Loader isolate with no network;
`python` and POSIX programs run on a code engine the runtime's host installs
(`@statewalker/ai-environment/code-engines`), ENOSYS elsewhere. Running code is the `code.run:<kind>`
action (roles, mode, approvals naming the exact run); an agent's `requires` is checked at session
start; each run's time is charged as `executor_cpu_ms:<kind>` to the session, member, project and
workspace, and the run is killed when a limit refuses more. The external executor pool is an
interface (`ExecutorPool`).
