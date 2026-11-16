# @statewalker/ai-local-models.core

## 0.7.0

### Minor Changes

- 607236d: **Move to `@statewalker/webrun-files` 0.12 and the kernel 0.8 line built on it** (statewalker/statewalker-ai#28). The dependency ranges move to these breaking lines:
  - webrun-files, -composite and -mem go to ^0.12.0;
  - workspace.core and settings.core go to ^0.8.0.
  
  webrun-files 0.12 resolves `..` segments before any filter, guard or mount sees a path, and throws `Path climbs above the root` for a path above the root. The agent's tools view therefore cannot reach the system folder through a path such as `/work/../.settings/x`.

### Patch Changes

- Updated dependencies [607236d]
  - @statewalker/ai-agent-runtime.core@0.7.0
  - @statewalker/ai-agent.core@0.5.0
  - @statewalker/ai-local-models.browser@0.5.0

## 0.6.1

### Patch Changes

- Release of the changes since the last published version:
  
  - @statewalker/ai-local-models.browser ^0.4.2 -> ^0.4.3

## 0.6.0

### Minor Changes

- Release of the changes since the last published version:
  
  - @statewalker/settings.core ^0.5.0 -> ^0.7.0
  - @statewalker/workspace.core ^0.5.0 -> ^0.7.0

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @statewalker/ai-agent.core@0.4.3
  - @statewalker/ai-agent-runtime.core@0.6.0

## 0.5.2

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: README.md
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @statewalker/ai-agent.core@0.4.2
  - @statewalker/ai-agent-runtime.core@0.5.2
  - @statewalker/ai-local-models.browser@0.4.2

## 0.1.1

### Patch Changes

- Initial public release from the statewalker multi-repo ecosystem.
- Updated dependencies
  - @statewalker/ai-agent-runtime.core@0.1.1
  - @statewalker/ai-agent.core@0.1.1
  - @statewalker/ai-local-models.browser@0.1.1
  - @statewalker/settings.core@0.1.1
  - @statewalker/workspace.core@0.1.1
