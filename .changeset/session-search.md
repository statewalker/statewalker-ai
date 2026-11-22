---
"@statewalker/ai-sessions": minor
"@statewalker/ai-host-do": minor
"@statewalker/ai-memory": patch
---

Session search and the session table of contents (statewalker/statewalker-root#174): during compaction the summarizer writes each session's topics (an append-only `topics` table, merged with superseding rows, refs to leaf items, following the active path); `GET /v1/sessions/{id}/topics` (`?branch=`, `?all=true`) and the RPC method `listTopics` serve them; the session index keeps each session's topic titles; the harness tool `session_search` scans the user's own sessions in the project (sub-agents' included), topics first and items as fallback, fenced as data, behind the `SessionSearch` interface.
Memory's `search` action and `session_search` share one regular-expression guard (`searchRegExp`): a repeated group holding a repetition or an alternation is refused.
