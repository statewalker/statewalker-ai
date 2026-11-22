---
"@statewalker/ai-environment": minor
"@statewalker/ai-sessions": minor
"@statewalker/ai-host-do": minor
---

Usage and limits API (statewalker/statewalker-root#181): `GET /v1/limits/effective`, `GET /v1/usage?level&period&group_by`, `GET/PUT/DELETE /v1/limits/{level}/{target}` and the NDJSON export `GET /v1/usage/records?since` (the workspace admin's, and every workspace's with the operator token `OPERATOR_KEY`), over REST and RPC. Turns and sessions carry their model usage totals. Usage under a user's own key is shown with its amounts to that user alone. `LimitLedger` gains `states`, `aggregate` and `recordsFrom`; `groupUsage` groups usage rows. The test-only `/admin/workspaces/<ws>/usage-records` and `/admin/users/<u>/usage-records` routes are removed.
