# @statewalker/ai-openai-compat

## 0.2.0

### Minor Changes

- Release of the changes since the last published version:
  
  - @statewalker/ai-access crosses a breaking line
  - @statewalker/ai-sessions crosses a breaking line

### Patch Changes

- Updated dependencies [b550856]
  - @statewalker/ai-access@0.2.0
  - @statewalker/ai-sessions@0.2.0

## 0.1.0

### Minor Changes

- a2a5575: The OpenAI projection (statewalker/statewalker-root#138): the new `ai-openai-compat` package
  serves `responses`, `conversations`, `chat/completions` and `models` at each agent's base URL
  `/v1/projects/<project>/agents/<agent>/`, so existing OpenAI clients drive harness agents; the
  Worker routes it, and `openAiFetch` runs it in the client over the session API's RPC methods. A
  message may name the turn it chains on (`after_turn`): an earlier turn moves the head there first,
  an implicit rewind that reverts no file, recorded by the item "head moved: chained on an earlier
  response". Concurrent changes the mode asks about in one turn each name their own approval.
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

- fa0b869: A Chat Completions stream no longer loses the answer of a turn that ends between the stream's up-to-date read of the session log and its check of the turn's status: it reads the events the turn logged meanwhile before it finishes (statewalker/statewalker-ai#95).
- 2e3414b: File pre-images and reverting files on rewind (statewalker/statewalker-root#191). The gate keeps,
  owner-side, the pre-image of every file an agent session (or a sub-agent it started) writes,
  deletes or moves, keyed by session and turn (`PreImageLog`, `preImaged` in ai-environment).
  Rewind, edit and regenerate accept `revert_files: true`: each file goes back to its state before
  the first rewound turn, only where nobody changed it since; the result's `files` lists what was
  reverted, the conflicts and the files whose pre-image is gone. The revert is one `write` under the
  mode: in `default` it waits on an approval (`files.approval`), and answering it allowed reverts the
  files then (`answerApproval` answers `files` and no `accepted`; `AgentPort.answerRevert`).
  Pre-images are kept 30 days or 100 MB per top-level session (deployment var `PRE_IMAGES`, workspace
  file `/.system/pre-images`), count toward the files meter, and are dropped with the session or the
  project. A fork's `forked_from` carries the pre-images' `checkpoint` when the gate kept any.
  `RunAction` gets the turn an action runs in.
- Updated dependencies [288a9b1]
- Updated dependencies [b00497e]
- Updated dependencies [870800b]
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
