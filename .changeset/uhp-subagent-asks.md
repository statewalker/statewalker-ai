---
"@statewalker/ai-sessions": minor
"@statewalker/ai-environment": minor
"@statewalker/ai-host-do": minor
"@statewalker/ai-uhp": minor
"@statewalker/ai-openai-compat": minor
---

A sub-agent's approval surfaces on its root session (statewalker/statewalker-ai#88): a turn whose
sub-agent (started with `agent.start`) waits on an approval now waits on it too, as a stored `agent`
action it does not record as its own, so the turn ends `waiting` instead of `completed`. Answering
the approval (or its expiry) continues the sub-agent, then each waiting turn up to the root with the
sub-agent's outcome; `answerApproval` reports those turns in `continued` (parent first) and
`ApprovalView.root` names the asking session's tree root. UHP asks it as the root response's
`input_request` and answers with the root's continuing turn; the OpenAI projection's
`mcp_approval_request` and the AI SDK UI stream's tool approval do the same on the root's call.
Passing the approval over at the root cancels it for the sub-agent too.
