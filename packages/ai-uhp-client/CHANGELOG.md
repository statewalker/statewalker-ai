# @statewalker/ai-uhp-client

## 0.1.0

### Minor Changes

- be60a0f: Remote agent sessions over UHP (statewalker/statewalker-root#144): the new `ai-uhp-client` package
  runs an agent session whose core is an external harness behind a UHP server (2026-10-19), started
  as `remote:<server>/<harness>` (or from an agent with `remote: {server, harness}`) with
  `agents.use:remote:<server>/<harness>`, which no built-in role holds. Files under the agent's
  `inputs` are copied in; artifacts are written back as one change set under the mode;
  `input_request` becomes an approval or a question (a `question` item); remote items are
  `external`; cancel, archive and revoke send UHP cancel. Servers are registered in `UHP_SERVERS` or a
  workspace's `/.system/uhp-servers`.

### Patch Changes

- a0b7f2e: Remote agent sessions follow the turn tree (statewalker/statewalker-ai#84): `TurnRun.path` gives a
  core the turn's active path, and a remote session's next task continues from the remote response on
  it (`previous_response_id`), so a rewind, a branch switch or an edit moves the remote session too; a
  fork, or a rewind before the first task, starts a fresh remote session with the files copied in
  again. A revoke or an archive that lands while a task's first POST is out now sends UHP cancel: the
  Workspace DO checks the answer against the capability's revocation ids.
  
  A turn resumed after a restart no longer becomes its own parent in the turn tree (its path looped).
- Updated dependencies [288a9b1]
- Updated dependencies [b00497e]
- Updated dependencies [870800b]
- Updated dependencies [7343fd2]
- Updated dependencies [24a5708]
- Updated dependencies [186eb63]
- Updated dependencies [2e3414b]
- Updated dependencies [eef62fd]
- Updated dependencies [85dfc29]
- Updated dependencies [66c5454]
- Updated dependencies [483d887]
- Updated dependencies [0a262dc]
- Updated dependencies [a2a5575]
- Updated dependencies [38358cf]
- Updated dependencies [be60a0f]
- Updated dependencies [a0b7f2e]
- Updated dependencies [5fa0aa7]
- Updated dependencies [a7f6bd8]
- Updated dependencies [04f2f47]
- Updated dependencies [77b06f0]
- Updated dependencies [04f2b73]
  - @statewalker/ai-access@0.1.0
  - @statewalker/ai-environment@0.1.0
  - @statewalker/ai-sessions@0.1.0
