---
"@statewalker/ai-sessions": minor
"@statewalker/ai-uhp-client": patch
"@statewalker/ai-host-do": patch
---

Remote agent sessions follow the turn tree (statewalker/statewalker-ai#84): `TurnRun.path` gives a
core the turn's active path, and a remote session's next task continues from the remote response on
it (`previous_response_id`), so a rewind, a branch switch or an edit moves the remote session too; a
fork, or a rewind before the first task, starts a fresh remote session with the files copied in
again. A revoke or an archive that lands while a task's first POST is out now sends UHP cancel: the
Workspace DO checks the answer against the capability's revocation ids.

A turn resumed after a restart no longer becomes its own parent in the turn tree (its path looped).
