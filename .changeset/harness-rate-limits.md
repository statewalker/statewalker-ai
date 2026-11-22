---
"@statewalker/ai-environment": minor
"@statewalker/ai-sessions": minor
"@statewalker/ai-flue": minor
"@statewalker/ai-host-do": minor
---

Rate limits (statewalker/statewalker-root#180): limits with `period: second | minute` and `on_exceed: delay` make a request wait for its window up to `LIMITS_MAX_DELAY_MS` (30 s), then deny it. New meters `api_requests` and `model_requests`. The session API's messages, SSE streams and session starts are limited per user (User DO) and per workspace (Workspace DO), 60 and 600 a minute by default, answering `429` with `Retry-After` (`UserPort.admitRequest`, `WorkspaceGrants.admitRequest`). A provider's `rate {rpm, tpm, share?, shares?}` holds each workspace to its share of a deployment key; over it a request waits, then falls back like a provider's 429 (`isRateRefusal`); with no model left a turn ends incomplete with `stop_reason: rate_limited`. A user's own keys are held to their own `user` limits on `model_requests` and `model_tokens`. `withDelay` takes a clock and keeps waiting until the max delay; `ModelMeter.admit` receives the provider; ledger charges take `{record: false}`.
