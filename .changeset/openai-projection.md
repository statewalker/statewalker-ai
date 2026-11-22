---
"@statewalker/ai-openai-compat": minor
"@statewalker/ai-sessions": minor
"@statewalker/ai-environment": patch
"@statewalker/ai-host-do": minor
---

The OpenAI projection (statewalker/statewalker-root#138): the new `ai-openai-compat` package
serves `responses`, `conversations`, `chat/completions` and `models` at each agent's base URL
`/v1/projects/<project>/agents/<agent>/`, so existing OpenAI clients drive harness agents; the
Worker routes it, and `openAiFetch` runs it in the client over the session API's RPC methods. A
message may name the turn it chains on (`after_turn`): an earlier turn moves the head there first,
an implicit rewind that reverts no file, recorded by the item "head moved: chained on an earlier
response". Concurrent changes the mode asks about in one turn each name their own approval.
