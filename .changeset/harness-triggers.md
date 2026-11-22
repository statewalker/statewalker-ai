---
"@statewalker/ai-access": minor
"@statewalker/ai-sessions": minor
"@statewalker/ai-host-do": minor
---

Triggers (statewalker/statewalker-root#207): schedules (cron in an IANA time zone or `at`, at most
every 15 minutes, missed fires recorded and the latest within an hour run once), webhooks
(`POST /v1/hooks/{id}`, HMAC over timestamp and body with replays refused, or the owner service
account's token; `Idempotency-Key`) and manual fires (`POST /v1/triggers/{id}/fire`), as consumers
of the project's task queue. Each fire runs an unattended turn as the trigger's owner, in the
trigger's mode, in a new session (archived after 30 days) or one of the owner's sessions;
`max_concurrent`, history, suspension on lost access, and the trigger API
(`/v1/projects/{p}/triggers`) over REST and RPC. ai-access: the `E2BIG` error (413) and a session
mode fixed in an agent session's capability.
