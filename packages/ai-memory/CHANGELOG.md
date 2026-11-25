# @statewalker/ai-memory

## 0.2.0

### Minor Changes

- Release of the changes since the last published version:
  
  - @statewalker/ai-access crosses a breaking line

### Patch Changes

- Updated dependencies [b550856]
  - @statewalker/ai-access@0.2.0

## 0.1.0

### Minor Changes

- 186eb63: Memory across sessions (statewalker/statewalker-root#173): the new `ai-memory` package, the memory
  tool for agents and the memory API (REST and RPC) for people, priming at session start and after
  compaction, and memory counted against the storage limits.

### Patch Changes

- 5fa0aa7: Session search and the session table of contents (statewalker/statewalker-root#174): during compaction the summarizer writes each session's topics (an append-only `topics` table, merged with superseding rows, refs to leaf items, following the active path); `GET /v1/sessions/{id}/topics` (`?branch=`, `?all=true`) and the RPC method `listTopics` serve them; the session index keeps each session's topic titles; the harness tool `session_search` scans the user's own sessions in the project (sub-agents' included), topics first and items as fallback, fenced as data, behind the `SessionSearch` interface.
  
  Memory's `search` action and `session_search` share one regular-expression guard (`searchRegExp`): a repeated group holding a repetition or an alternation is refused.
- Updated dependencies [288a9b1]
- Updated dependencies [b00497e]
- Updated dependencies [870800b]
- Updated dependencies [186eb63]
- Updated dependencies [66c5454]
- Updated dependencies [0a262dc]
- Updated dependencies [be60a0f]
  - @statewalker/ai-access@0.1.0
