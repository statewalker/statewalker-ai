---
"@statewalker/ai-uhp": minor
"@statewalker/ai-sessions": minor
"@statewalker/ai-openai-compat": minor
"@statewalker/ai-host-do": minor
---

The UHP projection (statewalker/statewalker-root#139): the new `ai-uhp` package serves UHP class
Core plus `input_requests`, pinned to UHP `2026-10-19`, under `/uhp`; each agent the user may start
is a harness `<project>/<plugin>/<agent>`, a UHP session is an agent session and a response a turn,
approvals go out one `input_request` at a time with scope "once", `branch: true` forks and
`previous_response_id` on an earlier response moves the head. The session API lists the agents the
caller may start (`listAgents`, `GET /v1/agents`), and a message may pass over the approvals the
session waits on (`void_approvals`, reported in `voided_approvals`). `ai-openai-compat` exports its
Responses event encoder (`EventEncoder`) and SSE helper (`sseResponse`) for reuse.
