# @statewalker/ai-uhp

## 0.1.0

### Minor Changes

- 04f2f47: The UHP projection (statewalker/statewalker-root#139): the new `ai-uhp` package serves UHP class
  Core plus `input_requests`, pinned to UHP `2026-10-19`, under `/uhp`; each agent the user may start
  is a harness `<project>/<plugin>/<agent>`, a UHP session is an agent session and a response a turn,
  approvals go out one `input_request` at a time with scope "once", `branch: true` forks and
  `previous_response_id` on an earlier response moves the head. The session API lists the agents the
  caller may start (`listAgents`, `GET /v1/agents`), and a message may pass over the approvals the
  session waits on (`void_approvals`, reported in `voided_approvals`). `ai-openai-compat` exports its
  Responses event encoder (`EventEncoder`) and SSE helper (`sseResponse`) for reuse.
- 77b06f0: A sub-agent's approval surfaces on its root session (statewalker/statewalker-ai#88): a turn whose
  sub-agent (started with `agent.start`) waits on an approval now waits on it too, as a stored `agent`
  action it does not record as its own, so the turn ends `waiting` instead of `completed`. Answering
  the approval (or its expiry) continues the sub-agent, then each waiting turn up to the root with the
  sub-agent's outcome; `answerApproval` reports those turns in `continued` (parent first) and
  `ApprovalView.root` names the asking session's tree root. UHP asks it as the root response's
  `input_request` and answers with the root's continuing turn; the OpenAI projection's
  `mcp_approval_request` and the AI SDK UI stream's tool approval do the same on the root's call.
  Passing the approval over at the root cancels it for the sub-agent too.

### Patch Changes

- Updated dependencies [288a9b1]
- Updated dependencies [b00497e]
- Updated dependencies [870800b]
- Updated dependencies [fa0b869]
- Updated dependencies [186eb63]
- Updated dependencies [2e3414b]
- Updated dependencies [eef62fd]
- Updated dependencies [85dfc29]
- Updated dependencies [66c5454]
- Updated dependencies [483d887]
- Updated dependencies [0a262dc]
- Updated dependencies [a2a5575]
- Updated dependencies [be60a0f]
- Updated dependencies [a0b7f2e]
- Updated dependencies [5fa0aa7]
- Updated dependencies [a7f6bd8]
- Updated dependencies [04f2f47]
- Updated dependencies [77b06f0]
- Updated dependencies [04f2b73]
  - @statewalker/ai-access@0.1.0
  - @statewalker/ai-sessions@0.1.0
  - @statewalker/ai-openai-compat@0.1.0
