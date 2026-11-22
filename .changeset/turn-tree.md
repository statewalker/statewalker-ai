---
"@statewalker/ai-sessions": minor
"@statewalker/ai-host-do": minor
"@statewalker/ai-flue": patch
---

The turn tree (statewalker/statewalker-root#190): an agent session's turns record `parent_turn`
and `origin`, the session has a movable head and the context is the root-to-head path. New session
API methods (RPC and REST, owner only): rewind (`POST /v1/sessions/{id}/rewind`), branch switch
(`PUT /v1/sessions/{id}/head`), edit and regenerate (`POST /v1/turns/{id}/edit|regenerate`), the
tree (`GET /v1/sessions/{id}/branches`), erasing an inactive branch
(`DELETE /v1/sessions/{id}/branches/{turn}`) and fork (`POST /v1/sessions/{id}/fork`). Items list
the active path by default (`?branch=`, `?all=true`). Agent DO storage is migrated in place.
