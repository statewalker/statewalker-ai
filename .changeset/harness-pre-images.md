---
"@statewalker/ai-environment": minor
"@statewalker/ai-sessions": minor
"@statewalker/ai-host-do": minor
"@statewalker/ai-openai-compat": patch
---

File pre-images and reverting files on rewind (statewalker/statewalker-root#191). The gate keeps,
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
